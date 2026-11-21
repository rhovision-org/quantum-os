// qos-process.test.mjs — PR gate quantum-os#264.
//
// Exercises the QOS process contract end to end without a network:
//
//   - the finite event schema and strict rholalc-facing parser;
//   - signed start/suspend/resume/terminate lifecycle events;
//   - the example composition (nominations -> ranked poll -> lemma-of-record
//     -> optional anchor) on three peer identities;
//   - identical final/state digests on independent peers fed the same
//     envelopes in opposite orders;
//   - offline peer / quorum hold / relay-gap recovery / source fork;
//   - capability attenuation, source binding, payload tamper, ZFA balance;
//   - both chain modes: no anchor event (zero chain) and an anchor event
//     (the reducer itself never calls a node).
//
//   node packages/browser/test/qos-process.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const buildOnce = await build({
  absWorkingDir: here,
  entryPoints: {
    "qos-process": join(here, "..", "src", "qos-process.ts"),
    dyncap: join(here, "..", "src", "dyncap.ts"),
    zfa: join(here, "..", "src", "zfa.ts"),
  },
  bundle: true,
  outdir: join(here, "out"),
  format: "esm",
  platform: "node",
  write: false,
});
const modules = {};
for (const file of buildOnce.outputFiles) {
  const name = basename(file.path).replace(/\.js$/, "");
  modules[name] = await import(
    "data:text/javascript;base64," + Buffer.from(file.text).toString("base64")
  );
}
const Q = modules["qos-process"];
const D = modules["dyncap"];
const Z = modules["zfa"];

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`);
  }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

// A valid ZFA room token. (The published demo room cap is only checked with a
// warning by peer.ts; orchestration needs an actual valid capability.)
const ROOM = "cap:room:03010563656127610341634101250325";
const clone = (value) => JSON.parse(JSON.stringify(value));

function identity(n) {
  const seed = new Uint8Array(32);
  for (let i = 0; i < seed.length; i++) seed[i] = (i * 37 + n * 13 + 7) & 0xff;
  return D.newDynCapState(seed);
}

function makeRoom(id) {
  const sent = [];
  const room = new Q.QosProcessRoom({
    roomId: ROOM,
    identity: id,
    transport: { broadcast: (data) => sent.push(data) },
  });
  return { room, sent };
}

async function deliver(target, events) {
  let accepted = 0;
  for (const event of events) if (await target.onMessage("test-peer", event)) accepted++;
  return accepted;
}

// ---------------------------------------------------------------------------
// 1. Finite event model and strict parser
// ---------------------------------------------------------------------------

console.log("\nevent model");
eq("the event vocabulary is finite and explicit", Q.QOS_EVENT_TYPES, [
  "process-start", "process-suspend", "process-resume", "process-terminate",
  "capability-grant", "nomination", "poll-open", "ballot", "poll-close",
  "lemma", "anchor",
]);
ok("an unknown type is rejected", Q.parseQosEvent({ kind: "qos-event", schema: Q.QOS_EVENT_SCHEMA, type: "unknown" }) === null);
ok("a non-event is rejected", Q.parseQosEvent(null) === null);
ok("canonical JSON sorts keys recursively",
  Q.canonicalJson({ b: 2, a: { d: 4, c: 3 } }) === '{"a":{"c":3,"d":4},"b":2}');
// Causal canonicalization must override stable tuple order when a dependency
// exists, while using compareEvents only among ready events.
{
  const ev = (hash, source, seq, prev = "genesis", grant = "root") => ({ hash, source, seq, prev, grant });
  const parent = ev("p", "z-source", 1);
  const child = ev("c", "a-source", 1, "p");
  const concurrent = ev("x", "m-source", 1);
  const ordered = Q.canonicalEventOrder([child, concurrent, parent]);
  ok("causal predecessor is ordered before its consumer", ordered.ordered.findIndex(e => e.hash === "p") < ordered.ordered.findIndex(e => e.hash === "c"));
  ok("valid explicit dependencies produce no missing refs or cycles", ordered.missingDependencies.length === 0 && ordered.cyclicHashes.length === 0);
  const permuted = Q.canonicalEventOrder([parent, child, concurrent]);
  eq("arrival permutation preserves causal canonical order", permuted.ordered.map(e => e.hash), ordered.ordered.map(e => e.hash));
  const permutations = [
    [child, concurrent, parent], [child, parent, concurrent],
    [concurrent, child, parent], [concurrent, parent, child],
    [parent, child, concurrent], [parent, concurrent, child],
  ];
  ok("all permutations produce the same causal canonical order", permutations.every(input =>
    JSON.stringify(Q.canonicalEventOrder(input).ordered.map(e => e.hash)) === JSON.stringify(ordered.ordered.map(e => e.hash))));
  const grant = ev("g", "b-source", 2);
  const granted = ev("q", "a-source", 3, "genesis", "g");
  eq("grant dependency is ordered before its consumer", Q.canonicalEvents([granted, grant]).map(e => e.hash), ["g", "q"]);
  const missing = Q.canonicalEventOrder([ev("m1", "a", 1, "missing-prev")]);
  ok("missing dependencies are surfaced", missing.missingDependencies.length === 1 && missing.missingDependencies[0].kind === "prev");
  const cycle = Q.canonicalEventOrder([ev("cy1", "a", 1, "cy2"), ev("cy2", "b", 1, "cy1")]);
  eq("dependency cycles are surfaced deterministically", cycle.cyclicHashes, ["cy1", "cy2"]);
}

// ---------------------------------------------------------------------------
// 2. Capability derivation and attenuation
// ---------------------------------------------------------------------------

console.log("\ncapability attenuation");
const child = Q.deriveProcessCapability(ROOM, "0123456789abcdef");
ok("a derived process capability is a valid ZFA token", Z.validateCapability(child), child);
ok("the child is structurally attenuated from the room token", Q.isCapabilityAttenuated(ROOM, child));
ok("a non-extension is not attenuated", !Q.isCapabilityAttenuated(child, Q.deriveProcessCapability(ROOM, "ffff")));
ok("an invalid parent cannot mint a child",
  (() => { try { Q.deriveProcessCapability("not-a-cap", "aa"); return false; } catch { return true; } })());

const rootScope = Q.newRootScope("qos:proc:test");
const participant = Q.newParticipantScope("qos:proc:test", ["nomination", "ballot"]);
ok("a participant scope narrows cleanly", Q.attenuateScope(rootScope, participant) !== null);
ok("adding a right not in the parent is refused",
  Q.attenuateScope(participant, { ...participant, canAnchor: true }) === null);
ok("adding an event type not in the parent is refused",
  Q.attenuateScope(participant, { ...participant, events: ["nomination", "anchor"] }) === null);

// ---------------------------------------------------------------------------
// 3. Signed lifecycle
// ---------------------------------------------------------------------------

console.log("\nprocess identity and signed lifecycle");
{
  const id = await identity(10);
  const { room } = makeRoom(id);
  const started = await room.startProcess("lifecycle", {
    question: "does the process stay named and signed?",
    minNominations: 1,
    entropyHex: "00112233",
  });
  const pid = started.processId;
  const events = room.log.eventsFor(pid);
  ok("start is a named, capability-guarded process event", started.event.type === "process-start" && pid.startsWith("qos:proc:"));
  ok("start carries a dyncap-signed envelope", started.event.dyncap.anchor === id.anchor && started.event.dyncap.seq === started.event.seq);
  ok("start's capability is valid ZFA", Z.validateCapability(started.capability));
  eq("start leaves the process running", (await room.view(pid)).status, "running");

  await room.suspend(pid, started.event, "pause");
  eq("suspend is a signed event and leaves the process suspended", (await room.view(pid)).status, "suspended");
  await room.resume(pid, started.event, "continue");
  eq("resume is a signed event and leaves the process running", (await room.view(pid)).status, "running");
  await room.terminate(pid, started.event, "done");
  const terminated = await room.view(pid);
  eq("terminate is a signed event and is terminal", terminated.status, "terminated");
  const lifecycle = room.log.eventsFor(pid).map((event) => event.type);
  eq("the signed lifecycle vocabulary is present", lifecycle,
    ["process-start", "process-suspend", "process-resume", "process-terminate"]);
  ok("the process action history still achieves ZFA", Q.zfaHistoryAchievesZfa(room.log.eventsFor(pid)));
}

// ---------------------------------------------------------------------------
// 4. The example composition, on three peers, two delivery orders
// ---------------------------------------------------------------------------

async function composition({ withAnchor }) {
  const a = await identity(1);
  const b = await identity(2);
  const c = await identity(3);
  const A = makeRoom(a);
  const B = makeRoom(b);
  const C = makeRoom(c);

  const started = await A.room.startProcess("nominate-and-rank", {
    question: "Which option should be recorded?",
    quorum: { required: 3 },
    participants: [a.anchor, b.anchor, c.anchor],
    minNominations: 2,
    entropyHex: "0123456789abcdef",
  });
  const pid = started.processId;
  await deliver(B.room, [started.event]);
  await deliver(C.room, [started.event]);

  const grantB = await A.room.grant(pid, started.event, b.anchor,
    Q.newParticipantScope(pid, ["nomination", "ballot"]), "aaa111");
  const grantC = await A.room.grant(pid, started.event, c.anchor,
    Q.newParticipantScope(pid, ["nomination", "ballot"]), "bbb222");
  await deliver(B.room, A.room.log.eventsFor(pid));
  await deliver(C.room, A.room.log.eventsFor(pid));

  const bGrant = B.room.findGrant(pid, b.anchor);
  const cGrant = C.room.findGrant(pid, c.anchor);
  ok("each participant finds the grant bound to its own anchor",
    bGrant?.payload.to === b.anchor && cGrant?.payload.to === c.anchor);

  const nomB = await B.room.nominates(pid, bGrant, "Alpha");
  const nomC = await C.room.nominates(pid, cGrant, "Beta");
  await deliver(A.room, [nomB, nomC]);
  await deliver(B.room, [nomC]);
  await deliver(C.room, [nomB]);

  const open = await A.room.openPoll(pid, started.event, { minBallots: 3 });
  await deliver(B.room, [open]);
  await deliver(C.room, [open]);

  const alpha = Q.optionId("Alpha");
  const beta = Q.optionId("Beta");
  const ballotA = await A.room.castsBallot(pid, started.event, [alpha, beta]);
  const ballotB = await B.room.castsBallot(pid, bGrant, [alpha, beta]);
  const ballotC = await C.room.castsBallot(pid, cGrant, [beta, alpha]);
  await deliver(A.room, [ballotB, ballotC]);
  await deliver(B.room, [ballotA, ballotC]);
  await deliver(C.room, [ballotA, ballotB]);

  const closed = await A.room.closePoll(pid, started.event);
  await deliver(B.room, [closed]);
  await deliver(C.room, [closed]);

  const lemma = await A.room.recordLemma(pid, started.event, "qos-decision");
  await deliver(B.room, [lemma]);
  await deliver(C.room, [lemma]);

  let anchor = null;
  if (withAnchor) {
    anchor = await A.room.anchor(pid, started.event, {
      chain: "rholo", deployId: "deploy-abc123", blockHash: "block-42",
    });
    await deliver(B.room, [anchor]);
    await deliver(C.room, [anchor]);
  }

  // Give every local room the same complete set; duplicates are idempotent.
  const all = A.room.log.eventsFor(pid);
  await deliver(B.room, all);
  await deliver(C.room, all);

  const viewA = await A.room.view(pid);
  const viewB = await B.room.view(pid);
  const viewC = await C.room.view(pid);
  return { a, b, c, A, B, C, pid, started, all, viewA, viewB, viewC, lemma, anchor };
}

console.log("\nexample composition — anchored");
{
  const run = await composition({ withAnchor: true });
  eq("the anchored composition reaches the anchored phase", run.viewA.phase, "anchored");
  eq("the ranked poll records the expected winner", run.viewA.winnerTexts, ["Alpha"]);
  ok("a final digest exists", typeof run.viewA.finalDigest === "string" && run.viewA.finalDigest.length === 64);
  ok("the anchor is an event, not a reducer call",
    run.viewA.chainMode === "anchor-event" && run.viewA.anchor?.deployId === "deploy-abc123");
  eq("all three room peers agree on the final digest",
    [run.viewB.finalDigest, run.viewC.finalDigest], [run.viewA.finalDigest, run.viewA.finalDigest]);
  eq("all three room peers agree on the full state digest",
    [run.viewB.stateDigest, run.viewC.stateDigest], [run.viewA.stateDigest, run.viewA.stateDigest]);
  ok("no source chain is missing a link", run.viewA.brokenChains.length === 0, JSON.stringify(run.viewA.brokenChains));
  ok("the composition's action history achieves ZFA", Q.zfaHistoryAchievesZfa(run.all));

  // Two independent reducers, same envelopes, opposite order.
  const logForward = new Q.QosEventLog(ROOM);
  const logReverse = new Q.QosEventLog(ROOM);
  for (const event of run.all) await logForward.ingest(event);
  for (const event of [...run.all].reverse()) await logReverse.ingest(event);
  const forward = await Q.orchestrate(logForward.events(), { forkedSources: logForward.forkedSources });
  const reverse = await Q.orchestrate(logReverse.events(), { forkedSources: logReverse.forkedSources });
  eq("arrival order does not change the final digest", forward.finalDigest, reverse.finalDigest);
  eq("arrival order does not change the state digest", forward.stateDigest, reverse.stateDigest);
  eq("the public event-log view uses causal canonical ordering",
    logForward.events().map((event) => event.hash), logReverse.events().map((event) => event.hash));
  eq("the canonical public event view matches the explicit causal order",
    logForward.events().map((event) => event.hash), Q.canonicalEventOrder(run.all).ordered.map((event) => event.hash));
  ok("the rholalc-facing parser round-trips every emitted envelope",
    run.all.every((event) => {
      const parsed = Q.parseQosEvent(clone(event));
      return parsed !== null && parsed.hash === event.hash;
    }));
  ok("the strict parser rejects an added field",
    Q.parseQosEvent({ ...clone(run.all[0]), extra: true }) === null);
  ok("the strict parser rejects a different schema",
    Q.parseQosEvent({ ...clone(run.all[0]), schema: "qos.event/2" }) === null);
}

console.log("\nexample composition — no chain");
{
  const run = await composition({ withAnchor: false });
  eq("without an anchor event the composition stops at recorded", run.viewA.phase, "recorded");
  eq("the no-chain path still produces the same record", run.viewA.winnerTexts, ["Alpha"]);
  ok("zero-chain mode has no anchor and no chain mode", run.viewA.anchor === null && run.viewA.chainMode === "none");
  ok("the no-chain path still has a final digest", run.viewA.finalDigest === run.viewA.recordHash);
}

// ---------------------------------------------------------------------------
// 5. Failure and partial participation
// ---------------------------------------------------------------------------

console.log("\noffline peer, relay gap, and conflict");
{
  const run = await composition({ withAnchor: false });
  const withoutC = run.all.filter((event) => event.source !== run.c.anchor);
  const partial = new Q.QosEventLog(ROOM);
  for (const event of withoutC) await partial.ingest(event);
  const blocked = await Q.orchestrate(partial.events(), { forkedSources: partial.forkedSources });
  eq("a missing participant holds the process at quorum", blocked.blocked, "quorum");
  ok("no trusted orchestrator can invent the missing peer's record", blocked.finalDigest === null);
  ok("the missing participant is named", blocked.quorum.missing.includes(run.c.anchor), JSON.stringify(blocked.quorum.missing));

  // A relay that drops one envelope in the middle of a source's chain is a
  // different failure from a peer that is absent: the source is present, but
  // the chain has a hole and the phase cannot advance.
  const gapEvents = run.all.filter((event) => !(event.source === run.a.anchor && event.type === "ballot"));
  const gap = new Q.QosEventLog(ROOM);
  for (const event of gapEvents) await gap.ingest(event);
  const gapped = await Q.orchestrate(gap.events(), { forkedSources: gap.forkedSources });
  eq("a dropped ballot holds the poll", gapped.blocked, "ballots");
  ok("the missing relayed event shows up as a broken source chain",
    gapped.brokenChains.some((entry) => entry.source === run.a.anchor),
    JSON.stringify(gapped.brokenChains));

  // Any peer can serve the missing envelopes; the reducer converges.
  await Q.mergeEventLogs(partial, run.A.room.log);
  const recovered = await Q.orchestrate(partial.events(), { forkedSources: partial.forkedSources });
  eq("merging the missing participant's envelopes recovers the final digest", recovered.finalDigest, run.viewA.finalDigest);
  await Q.mergeEventLogs(gap, run.A.room.log);
  const gapRecovered = await Q.orchestrate(gap.events(), { forkedSources: gap.forkedSources });
  eq("merging a relay gap recovers the same state digest", gapRecovered.stateDigest, run.viewA.stateDigest);
}

console.log("\nsource fork");
{
  const cap = Q.deriveProcessCapability(ROOM, "cafe");
  const pid = Q.processIdFor("fork-test", cap);
  const seedA = new Uint8Array(32).fill(9);
  const seedB = new Uint8Array(32).fill(9);
  const stA = await D.newDynCapState(seedA);
  const stB = await D.newDynCapState(seedB);
  const signerA = new Q.QosEventSigner(stA, ROOM);
  const signerB = new Q.QosEventSigner(stB, ROOM);
  const payloadA = {
    name: "fork-test", question: "one", rootCapability: cap,
    scope: Q.newRootScope(pid), quorum: { required: 1 }, minNominations: 1,
  };
  const payloadB = { ...payloadA, question: "two" };
  const eventA = await signerA.sign(pid, cap, "root", "process-start", payloadA);
  const eventB = await signerB.sign(pid, cap, "root", "process-start", payloadB);
  ok("two distinct events share one source+seq", eventA.source === eventB.source && eventA.seq === eventB.seq && eventA.hash !== eventB.hash);

  const log = new Q.QosEventLog(ROOM);
  ok("the first branch is accepted", (await log.ingest(eventA)).ok === true);
  const second = await log.ingest(eventB);
  ok("the second branch is detected as a fork", second.ok === false && second.fork === true, JSON.stringify(second));
  ok("the forked source is quarantined", log.forkedSources.has(stA.anchor) && log.events().length === 0);
  const view = await Q.orchestrate(log.events(), { forkedSources: log.forkedSources });
  ok("a quarantined source cannot make the reducer guess", view.finalDigest === null && view.conflictedSources.includes(stA.anchor));
}
// The reducer must fail closed on explicit causal cycles even when supplied raw
// events (the room log normally rejects/diagnoses them before this boundary).
{
  const id = await identity(61);
  const { room } = makeRoom(id);
  const started = await room.startProcess("cycle-guard", { question: "cycle guard", minNominations: 1, entropyHex: "ab" });
  const cycleA = { hash: "cycle-a", source: "cycle-source", seq: 2, process: started.processId, prev: "cycle-b", grant: "root", type: "process-suspend" };
  const cycleB = { hash: "cycle-b", source: "cycle-source", seq: 3, process: started.processId, prev: "cycle-a", grant: "root", type: "process-resume" };
  const view = await Q.orchestrate([started.event, cycleA, cycleB]);
  ok("causal cycle makes the reducer conflicted", view.status === "conflicted" && view.phase === "conflicted");
  eq("cycle conflict is named", view.blocked, "causal-dependency-cycle");
  ok("cyclic hashes are surfaced in rejected diagnostics", view.rejected.length === 2 && view.rejected.every(e => /causal dependency cycle/.test(e.reason)));
}

// ---------------------------------------------------------------------------
// 6. Security invariant checks
// ---------------------------------------------------------------------------

console.log("\nsecurity invariants");
{
  const run = await composition({ withAnchor: false });
  const nomination = run.all.find((event) => event.type === "nomination");

  const tampered = { ...clone(nomination), payload: { ...nomination.payload, option: "Tampered" } };
  const tamperLog = new Q.QosEventLog(ROOM);
  const tamperResult = await tamperLog.ingest(tampered);
  ok("a changed payload is rejected by its hash", tamperResult.ok === false && /payload hash/.test(tamperResult.reason));

  const unbalanced = { ...clone(nomination), zfa: [0, 0] };
  ok("an unbalanced action history is rejected before it enters the log", Q.parseQosEvent(unbalanced) === null);
  ok("an invalid capability token is rejected before it enters the log",
    Q.parseQosEvent({ ...clone(nomination), capability: "cap:process:06" }) === null);

  const relabelled = { ...clone(nomination), source: "f".repeat(64) };
  const relabelLog = new Q.QosEventLog(ROOM);
  const relabelResult = await relabelLog.ingest(relabelled);
  ok("a source that is not the dyncap anchor is rejected", relabelResult.ok === false && /source/.test(relabelResult.reason));

  // B's child capability is public but bound to B. C signs an event with it;
  // the log can verify the envelope, while the reducer refuses the authority.
  const bGrant = run.B.room.findGrant(run.pid, run.b.anchor);
  const forged = await run.C.room.emit(run.pid, bGrant, "nomination", { option: "Forged" });
  const forgedLog = new Q.QosEventLog(ROOM);
  for (const event of [...run.all, forged]) await forgedLog.ingest(event);
  const forgedView = await Q.orchestrate(forgedLog.events(), { forkedSources: forgedLog.forkedSources });
  ok("a capability used by a different source is rejected by the reducer",
    forgedView.rejected.some((entry) => /bound to a different source/.test(entry.reason)),
    JSON.stringify(forgedView.rejected));
  ok("the forged nomination is not in the tally",
    !forgedView.nominations.some((nomination) => nomination.text === "Forged"));
  ok("the event action history of the full run achieves ZFA", Q.zfaHistoryAchievesZfa(run.all));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: qos-process.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
