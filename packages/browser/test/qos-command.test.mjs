// qos-command.test.mjs — the `/qos` surface over the QOS process contract.
//
// Two independent identities, one memory transport. Alice starts a process,
// Bob ingests the same signed event, and every lifecycle step must leave both
// reducers with the same state digest. Bob must not be able to drive Alice's
// lifecycle just because he saw the event.
//
//   node packages/browser/test/qos-command.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `
      export { QosCommand } from "./src/qos-command.ts";
      export { executeRhoProcessAsync } from "./src/rhoqu-process.ts";
      export { newDynCapState } from "./src/dyncap.ts";
    `,
    resolveDir: root,
    loader: "ts",
    sourcefile: "qos-command-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { QosCommand, newDynCapState, executeRhoProcessAsync } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

const ROOM = "cap:room:03010563656127610341634101250325";
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

async function peer(name) {
  const identity = await newDynCapState();
  const outbox = [];
  const said = [];
  const cmd = new QosCommand({
    roomId: ROOM,
    identity,
    transport: { broadcast: (data) => outbox.push(data) },
    say: (text) => said.push(text),
    label: (source) => (source === "Alice" || source === "Bob" ? source : name),
    onSigned: () => {},
  });
  return { name, cmd, outbox, said, identity };
}

async function drain(from, to) {
  while (from.outbox.length) {
    const data = from.outbox.shift();
    const accepted = await to.cmd.ingest(from.name, data);
    assert.equal(accepted, true, `delivery ${from.name} -> ${to.name}`);
  }
}

const alice = await peer("Alice");
const bob = await peer("Bob");

// --- start -----------------------------------------------------------------
await alice.cmd.handle("start Alpha | Should we ship?");
ok("start announces the process", alice.said.some((l) => l.includes("started") && l.includes("Alpha")));
const id = alice.cmd.list()[0]?.id;
ok("start tracks a process id", typeof id === "string" && id.startsWith("qos:proc:"), String(id));

await drain(alice, bob);
ok("the peer sees the start", bob.said.some((l) => l.includes("started") && l.includes("Alpha")));

let av = await alice.cmd.room.view(id);
let bv = await bob.cmd.room.view(id);
ok("start status is running", av.status === "running", av.status);
ok("both peers agree on the start digest", av.stateDigest === bv.stateDigest, `${av.stateDigest} != ${bv.stateDigest}`);

// --- status ----------------------------------------------------------------
await alice.cmd.handle("status");
ok("status lists the process", alice.said.some((l) => l.includes("QOS processes")) && alice.said.some((l) => l.includes("Alpha")));
await alice.cmd.handle(`status ${id}`);
ok("status detail carries the full digest", alice.said.some((l) => l.includes("state digest") && l.includes(av.stateDigest)));
ok("status detail names the owner", alice.said.some((l) => l.includes("owner: you")));

// --- ps --------------------------------------------------------------------
await alice.cmd.handle("ps");
ok("ps shows the process table", alice.said.some((l) => l.includes("QOS process table")) && alice.said.some((l) => l.includes("PID | NAME | STATE | EVENTS | OWNER")));
ok("ps names the process and owner", alice.said.some((l) => l.includes("Alpha") && l.includes("running") && l.includes("you")));
await bob.cmd.handle("ps");
ok("a peer sees the signed owner label", bob.said.some((l) => l.includes("Alpha") && l.includes("Alice")), JSON.stringify(bob.said.slice(-3)));

// --- suspend ---------------------------------------------------------------
await alice.cmd.handle("suspend Alpha | resting");
ok("suspend says so", alice.said.some((l) => l.includes("suspended")));
ok("suspend is past tense", !alice.said.some((l) => l.includes("suspendd")));
await drain(alice, bob);
av = await alice.cmd.room.view(id);
bv = await bob.cmd.room.view(id);
ok("status is suspended", av.status === "suspended", av.status);
ok("both peers agree after suspend", av.stateDigest === bv.stateDigest, `${av.stateDigest} != ${bv.stateDigest}`);

// --- only the owner can drive it ------------------------------------------
const before = bob.outbox.length;
await bob.cmd.handle("resume Alpha");
ok("a non-owner is refused", bob.said.some((l) => l.includes("only the process owner")));
ok("a refused lifecycle emits no event", bob.outbox.length === before, `${bob.outbox.length} vs ${before}`);

// --- resume ----------------------------------------------------------------
await alice.cmd.handle("resume Alpha");
await drain(alice, bob);
av = await alice.cmd.room.view(id);
bv = await bob.cmd.room.view(id);
ok("status is running again", av.status === "running", av.status);
ok("both peers agree after resume", av.stateDigest === bv.stateDigest, `${av.stateDigest} != ${bv.stateDigest}`);

// --- kill alias ------------------------------------------------------------
await alice.cmd.handle("start Killme | temporary");
await drain(alice, bob);
const killEntry = alice.cmd.list().find((p) => p.name === "Killme");
ok("a second process can be started", !!killEntry);
const beforeKill = bob.outbox.length;
await bob.cmd.handle("kill Killme");
ok("a non-owner kill is refused", bob.said.some((l) => l.includes("only the process owner")));
ok("a refused kill emits no event", bob.outbox.length === beforeKill, `${bob.outbox.length} vs ${beforeKill}`);
await alice.cmd.handle("kill Killme");
ok("kill is terminate's owner-only alias", alice.said.some((l) => l.includes("Killme") && l.includes("terminated")));
await drain(alice, bob);
const kv = killEntry ? await alice.cmd.room.view(killEntry.id) : null;
ok("kill leaves the process terminated", kv?.status === "terminated", kv?.status);

// --- terminate -------------------------------------------------------------
await alice.cmd.handle("terminate Alpha | done");
await drain(alice, bob);
av = await alice.cmd.room.view(id);
bv = await bob.cmd.room.view(id);
ok("status is terminated", av.status === "terminated", av.status);
ok("both peers agree after terminate", av.stateDigest === bv.stateDigest, `${av.stateDigest} != ${bv.stateDigest}`);

// --- invalid transitions and unknown names --------------------------------
await alice.cmd.handle("resume Alpha");
ok("resume from terminated is refused", alice.said.some((l) => l.includes("cannot resume") && l.includes("terminated")));
await alice.cmd.handle("suspend Nope");
ok("unknown process is named", alice.said.some((l) => l.includes("no process") && l.includes("Nope")));

// Actual QOS dispatcher, two concurrent branch-local bindings; no store diffs.
const rhoquPeer = await peer("RhoQu");
let queue = Promise.resolve();
const correlated = await executeRhoProcessAsync({kind: "parallel", branches: [
  {kind: "sequence", steps: [{kind:"command", command:"/qos start One", bind:"one"}, {kind:"command", command:"/qos status $one"}]},
  {kind: "sequence", steps: [{kind:"command", command:"/qos start Two", bind:"two"}, {kind:"command", command:"/qos status $two"}]},
]}, async command => {
  // Same serialization as the browser per-room sign queue.
  const run = queue.then(() => rhoquPeer.cmd.handle(command.slice(4).trim()));
  queue = run.then(() => undefined, () => undefined);
  const id = await run;
  return {lines: [], ...(id ? {id} : {})};
}, {strictBindings:true});
const idOne = rhoquPeer.cmd.list().find(p => p.name === "One")?.id;
const idTwo = rhoquPeer.cmd.list().find(p => p.name === "Two")?.id;
ok("parallel QOS starts return distinct exact dispatcher receipts", !!idOne && !!idTwo && idOne !== idTwo && correlated[0].id === idOne && correlated[2].id === idTwo);
ok("branch-local references resolve to own QOS process", correlated[1].command === "/qos status " + idOne && correlated[3].command === "/qos status " + idTwo);
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: qos-command.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
