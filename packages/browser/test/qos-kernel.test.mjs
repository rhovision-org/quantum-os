// qos-kernel.test.mjs — QOS/1 kernel ABI v0.
//
// Pure model: no browser, no network, no storage. Two independent kernels are
// fed the same operation sequence and must reach the same state digest.
//
//   node packages/browser/test/qos-kernel.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `
      export { QosKernel, replayQosKernel, previewCanonicalSyscall, QOS_ABI_VERSION, QOS_RIGHTS, QOS_ALL_RIGHTS, QOS_SYSCALLS, QOS_SIGNALS } from "./src/qos-kernel.ts";
      export { QosProcessRoom, QosEventLog } from "./src/qos-process.ts";
      export { newDynCapState } from "./src/dyncap.ts";
    `,
    resolveDir: root,
    loader: "ts",
    sourcefile: "qos-kernel-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const mod = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const { QosKernel, replayQosKernel, previewCanonicalSyscall, QosProcessRoom, QosEventLog, newDynCapState, QOS_ABI_VERSION, QOS_RIGHTS, QOS_ALL_RIGHTS, QOS_SYSCALLS, QOS_SIGNALS } = mod;

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};
const errno = (r) => (r.ok ? "OK" : r.errno);
const R = QOS_RIGHTS;

function bootstrap() {
  const k = new QosKernel();
  const init = k.createProcess({ name: "init", owner: "anchor:alice" });
  assert.equal(init.ok, true);
  return { k, init: init.value };
}

// --- constants -------------------------------------------------------------
ok("ABI version is 0", QOS_ABI_VERSION === 0);
ok("syscalls are finite and unique", new Set(QOS_SYSCALLS).size === QOS_SYSCALLS.length);
ok("signals are finite", QOS_SIGNALS.join(",") === "SIGTERM,SIGINT,SIGKILL,SIGCHLD");
ok("rights compose to 127", QOS_ALL_RIGHTS === 127);

// --- bootstrap / process table --------------------------------------------
{
  const { k, init } = bootstrap();
  ok("init has a pid", init.pid === "proc:1", init.pid);
  ok("init has a root handle", init.root === "h:1", init.root);
  ok("init is running", init.state === "running");
  ok("init has no parent", k.getppid(init.pid).value === null);

  const img = k.open(init.pid, "image:shell", R.READ | R.EXEC | R.GRANT, init.root);
  ok("open an executable image", img.ok, errno(img));
  const worker = k.spawn(init.pid, img.value.id, "worker");
  ok("spawn a child", worker.ok && worker.value.parent === init.pid, errno(worker));

  const grand = worker.ok ? k.spawn(worker.value.pid, worker.value.root, "grand") : null;
  ok("a child can spawn from its inherited root", grand && grand.ok && grand.value.parent === worker.value.pid, errno(grand ?? {}));
  ok("process table is sorted", k.list().map((p) => p.pid).join(",") === "proc:1,proc:2,proc:3");

  const bad = k.spawn(init.pid, "h:999", "nope");
  ok("spawn with an unknown image is EBADF", errno(bad) === "EBADF", errno(bad));
  const noExec = k.open(init.pid, "image:data", R.READ | R.GRANT, init.root);
  const noExecSpawn = k.spawn(init.pid, noExec.value.id, "nope");
  ok("spawn without EXEC is EACCES", errno(noExecSpawn) === "EACCES", errno(noExecSpawn));
  const noGrant = k.open(init.pid, "image:data2", R.READ | R.EXEC, init.root);
  const noGrantSpawn = k.spawn(init.pid, noGrant.value.id, "nope");
  ok("spawn without GRANT is EACCES", errno(noGrantSpawn) === "EACCES", errno(noGrantSpawn));
}

// --- attenuation / close / revoke ----------------------------------------
{
  const { k, init } = bootstrap();
  const img = k.open(init.pid, "image:shell", R.READ | R.EXEC | R.GRANT, init.root);
  const narrow = k.capDerive(init.pid, img.value.id, R.READ | R.EXEC);
  ok("derive a narrower handle", narrow.ok && narrow.value.rights === (R.READ | R.EXEC), errno(narrow));
  const broad = k.capDerive(init.pid, img.value.id, R.READ | R.WRITE | R.EXEC | R.GRANT);
  ok("derive cannot widen rights", errno(broad) === "EACCES", errno(broad));
  const zero = k.open(init.pid, "x", 0, init.root);
  ok("zero rights is EINVAL", errno(zero) === "EINVAL", errno(zero));
  const unknown = k.open(init.pid, "x", 128, init.root);
  ok("unknown rights bit is EINVAL", errno(unknown) === "EINVAL", errno(unknown));

  const ro = k.capDerive(init.pid, img.value.id, R.READ);
  const openFromRo = k.open(init.pid, "child", R.READ, ro.value.id);
  ok("open through a handle without GRANT is EACCES", errno(openFromRo) === "EACCES", errno(openFromRo));

  const closed = k.capClose(init.pid, narrow.value.id);
  ok("close a handle", closed.ok, errno(closed));
  const afterClose = k.capDerive(init.pid, narrow.value.id, R.READ);
  ok("closed handle is EBADF", errno(afterClose) === "EBADF", errno(afterClose));
  const closeRoot = k.capClose(init.pid, init.root);
  ok("root handle cannot be closed", errno(closeRoot) === "EINVAL", errno(closeRoot));

  const revoker = k.capDerive(init.pid, init.root, R.READ | R.EXEC | R.GRANT | R.REVOKE);
  const child = k.capDerive(init.pid, revoker.value.id, R.READ);
  const revoked = k.capRevoke(init.pid, revoker.value.id);
  ok("revoke marks the handle and descendants", revoked.ok && revoked.value >= 2, JSON.stringify(revoked));
  const afterRevoke = k.capDerive(init.pid, child.value.id, R.READ);
  ok("revoked descendant is EACCES", errno(afterRevoke) === "EACCES", errno(afterRevoke));
  const noRevoke = k.capDerive(init.pid, img.value.id, R.READ | R.EXEC | R.GRANT);
  const refuseRevoke = k.capRevoke(init.pid, noRevoke.value.id);
  ok("revoke without REVOKE is EACCES", errno(refuseRevoke) === "EACCES", errno(refuseRevoke));
}

// A closed intermediate is not a revocation boundary.
{
  const { k, init } = bootstrap();
  const authority = k.capDerive(init.pid, init.root, R.READ | R.EXEC | R.GRANT | R.REVOKE).value;
  const intermediate = k.capDerive(init.pid, authority.id, R.READ | R.EXEC | R.GRANT).value;
  const desc = k.capDerive(init.pid, intermediate.id, R.READ | R.GRANT).value;
  const child = k.spawn(init.pid, intermediate.id, "descendant").value;
  assert.ok(k.capClose(init.pid, intermediate.id).ok);
  const copy = k.cloneForReplay();
  const revoked = copy.capRevoke(init.pid, authority.id);
  ok("closed intermediate does not sever revocation chain", revoked.ok && revoked.value === 3);
  ok("grandchild handle is revoked across closed link", errno(copy.capDerive(init.pid, desc.id, R.READ)) === "EACCES");
  ok("spawned root inherits revocation ancestry", errno(copy.capDerive(child.pid, child.root, R.READ)) === "EACCES");
  ok("speculative clone revocation leaves original live", k.capDerive(init.pid, desc.id, R.READ).ok);
}
// --- signals / wait / exit ------------------------------------------------
{
  const { k, init } = bootstrap();
  const img = k.open(init.pid, "image:shell", R.READ | R.EXEC | R.GRANT, init.root);
  const worker = k.spawn(init.pid, img.value.id, "worker");
  const second = k.spawn(init.pid, img.value.id, "second");

  const noHandle = k.signal(init.pid, worker.value.pid, "SIGTERM");
  ok("signal without a process handle is EACCES", errno(noHandle) === "EACCES", errno(noHandle));

  const ctl = k.open(init.pid, `proc:${worker.value.pid}`, R.SIGNAL, init.root);
  ok("open a process-control handle", ctl.ok, errno(ctl));
  const killed = k.signal(init.pid, worker.value.pid, "SIGKILL");
  ok("owner can signal with a SIGNAL handle", killed.ok, errno(killed));
  const wv = k.getProcess(worker.value.pid);
  ok("SIGKILL marks the process exited", wv?.state === "exited" && wv.exitCode === -9, JSON.stringify(wv));

  const waited = k.wait(init.pid, worker.value.pid);
  ok("wait reaps the child with its exit code", waited.ok && waited.value === -9, JSON.stringify(waited));
  const again = k.wait(init.pid, worker.value.pid);
  ok("waiting twice is ENOENT", errno(again) === "ENOENT", errno(again));

  const other = k.createProcess({ name: "other", owner: "anchor:bob" });
  const notParent = k.wait(other.value.pid, second.value.pid);
  ok("non-parent wait is EACCES", errno(notParent) === "EACCES", errno(notParent));

  const running = k.wait(init.pid, second.value.pid);
  ok("waiting on a running child is EAGAIN", errno(running) === "EAGAIN", errno(running));

  const self = k.signal(init.pid, init.pid, "SIGCHLD");
  ok("self signal is allowed and does not exit", self.ok && k.getProcess(init.pid)?.state === "running", errno(self));

  const exited = k.exit(second.value.pid, 7);
  ok("exit with a code", exited.ok, errno(exited));
  const secondWait = k.wait(init.pid, second.value.pid);
  ok("wait returns the explicit exit code", secondWait.ok && secondWait.value === 7, JSON.stringify(secondWait));
  const doubleExit = k.exit(second.value.pid, 0);
  ok("double exit is EINVAL", errno(doubleExit) === "EINVAL", errno(doubleExit));
  ok("exited process has no handles", (k.getProcess(second.value.pid)?.handles.length ?? -1) === 0);
}

// --- journal-backed kernel replay ------------------------------------------
{
  const identity = await newDynCapState(new Uint8Array(32).fill(21));
  const room = new QosProcessRoom({
    roomId: "cap:room:03010563656127610341634101250325", identity,
    transport: { broadcast: () => {} },
  });
  const started = await room.startProcess("replay-worker", { entropyHex: "aa" });
  await room.suspend(started.processId, started.event, "pause for replay");
  await room.resume(started.processId, started.event, "continue");
  await room.terminate(started.processId, started.event, "complete");
  const events = room.log.events();
  const replayA = replayQosKernel(events);
  const replayB = replayQosKernel([...events].reverse());
  const procA = replayA.kernel.getProcess(started.processId);
  const procB = replayB.kernel.getProcess(started.processId);
  ok("journal replay reconstructs process identity", procA?.name === "replay-worker" && procA?.owner === identity.anchor);
  ok("journal replay applies lifecycle transitions", procA?.state === "exited" && procA?.exitCode === 0);
  ok("reverse delivery reaches the same kernel digest", await replayA.kernel.stateDigest() === await replayB.kernel.stateDigest());
  ok("replay reports every accepted lifecycle event", replayA.applied.length === events.length && replayA.rejected.length === 0);
  const incomplete = replayQosKernel(events.slice(1));
  ok("replay refuses lifecycle without its causal start", incomplete.kernel.list().length === 0 && incomplete.rejected.length > 0);
  ok("replay rejects all descendants of missing causal input", incomplete.rejected.length === events.length - 1);
  ok("replay reports missing causal dependencies", incomplete.missingDependencies.length > 0);
}

// Start ambiguity cannot create an arbitrary authoritative process.
{
  const roomId = "cap:room:03010563656127610341634101250325";
  const a = new QosProcessRoom({roomId, identity:await newDynCapState(new Uint8Array(32).fill(85)),transport:{broadcast:()=>{}}});
  const b = new QosProcessRoom({roomId, identity:await newDynCapState(new Uint8Array(32).fill(86)),transport:{broadcast:()=>{}}});
  const x = await a.startProcess("ambiguous", {entropyHex:"ab"});
  const y = await b.startProcess("ambiguous", {rootCapability:x.capability});
  const events = [x.event,y.event];
  const f = replayQosKernel(events), r = replayQosKernel([...events].reverse());
  ok("conflicting starts create no arbitrary process", f.kernel.list().length === 0 && f.rejected.length === 2);
  ok("conflicting starts reject identically in reverse order", JSON.stringify(f.rejected) === JSON.stringify(r.rejected));
}
// --- canonical syscall request/result/refusal round-trip -------------------
{
  const identity = await newDynCapState(new Uint8Array(32).fill(37));
  const roomId = "cap:room:03010563656127610341634101250325";
  const room = new QosProcessRoom({ roomId, identity, transport: { broadcast: () => {} } });
  const started = await room.startProcess("syscall-worker", { entropyHex: "ab" });
  const pid = started.processId;
  const invoke = async (op, args) => {
    const version = typeof args.handle === "string" ? replayQosKernel(room.log.events()).kernel.handleVersion(pid,args.handle) : undefined;
    const payload = { schema: "qos.syscall/1", caller: pid, op, args: {...args,...(version ? {handleVersion:version} : {})} };
    const request = await room.emit(pid, started.event, "syscall-request", payload);
    const replay = replayQosKernel(room.log.events());
    const outcome = previewCanonicalSyscall(replay.kernel, payload, pid, request.hash);
    assert.ok(outcome);
    await room.emit(pid, started.event, "syscall-result", { schema: "qos.syscall/1", requestHash: request.hash, outcome });
    return outcome;
  };
  const root = replayQosKernel(room.log.events()).kernel.getProcess(pid).root;
  const initial = await invoke("getpid", {});
  const derived = await invoke("cap_derive", { handle: root, rights: R.READ });
  const refused = await invoke("cap_close", { handle: "h:unknown" });
  ok("canonical getpid round-trips", initial.ok && initial.value === pid);
  ok("canonical capability derivation returns handle", derived.ok && derived.value.rights === R.READ);
  ok("canonical refusal carries EBADF", !refused.ok && refused.errno === "EBADF");
  const events = room.log.events();
  const forward = new QosEventLog(roomId), reverse = new QosEventLog(roomId);
  for (const log of [forward, reverse]) for (const event of log === forward ? events : [...events].reverse()) assert.equal((await log.ingest(event)).ok, true);
  const a = replayQosKernel(forward.events()), b = replayQosKernel(reverse.events());
  ok("independent logs replay identical canonical syscall traces", JSON.stringify(a.syscalls) === JSON.stringify(b.syscalls) && a.syscalls.length === 3);
  ok("independent peer delivery yields identical state digest", await a.kernel.stateDigest() === await b.kernel.stateDigest());
  ok("result contains request hash, caller, handle, outcome and position", a.syscalls[2].caller === pid && a.syscalls[2].args.handle === "h:unknown" && a.syscalls[2].position === 6);
  ok("all admitted canonical events accounted for", a.rejected.length === 0 && a.pendingSyscalls.length === 0 && a.applied.length === events.length);
  const pendingPayload = { schema: "qos.syscall/1", caller: pid, op: "cap_derive", args: { handle: root, rights: R.READ, handleVersion: started.event.hash } };
  const before = await a.kernel.stateDigest();
  const request = await room.emit(pid, started.event, "syscall-request", pendingPayload);
  const pendingReplay = replayQosKernel(room.log.events());
  ok("unanswered request changes no state", await pendingReplay.kernel.stateDigest() === before && pendingReplay.pendingSyscalls[0] === request.hash);
  await room.emit(pid, started.event, "syscall-result", { schema: "qos.syscall/1", requestHash: request.hash, outcome: { ok: false, errno: "EINVAL" } });
  const bad = replayQosKernel(room.log.events());
  ok("valid-envelope false outcome cannot mutate kernel", bad.rejected.some(e => e.reason.includes("outcome differs")) && await bad.kernel.stateDigest() === before);
  const wide = previewCanonicalSyscall(a.kernel, { schema: "qos.syscall/1", caller: pid, op: "cap_derive", args: { handle: root, rights: 2 ** 32 + 1 } }, pid);
  ok("oversized rights cannot wrap into allowed mask", !wide.ok && wide.errno === "EINVAL");
  ok("caller cannot name another process", previewCanonicalSyscall(a.kernel, { schema: "qos.syscall/1", caller: "other", op: "getpid", args: {} }, pid) === null);
}

// Unrelated earlier history must not renumber a process's root or derived handle.
{
  const roomId = "cap:room:03010563656127610341634101250325";
  const identities = await Promise.all([newDynCapState(new Uint8Array(32).fill(91)),newDynCapState(new Uint8Array(32).fill(92))]);
  identities.sort((a,b) => a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0);
  const make = identity => new QosProcessRoom({roomId, identity, transport:{broadcast:()=>{}}});
  const late = make(identities[0]), original = make(identities[1]);
  const start = await original.startProcess("original", {entropyHex:"ab"});
  const pid = start.processId;
  const root = replayQosKernel(original.log.events()).kernel.getProcess(pid).root;
  const payload = {schema:"qos.syscall/1",caller:pid,op:"cap_derive",args:{handle:root,rights:R.READ,handleVersion:start.event.hash}};
  const req = await original.emit(pid,start.event,"syscall-request",payload);
  const outcome = previewCanonicalSyscall(replayQosKernel(original.log.events()).kernel,payload,pid,req.hash);
  assert.ok(outcome.ok);
  await original.emit(pid,start.event,"syscall-result",{schema:"qos.syscall/1",requestHash:req.hash,outcome});
  const independent = await late.startProcess("independent",{entropyHex:"cd"});
  const old = replayQosKernel(original.log.events());
  const union = [independent.event,...original.log.events()];
  const merged = replayQosKernel(union), reverse = replayQosKernel([...union].reverse());
  ok("root ID anchored to the process-start event", root === "h:start:" + start.event.hash);
  ok("derived ID anchored to the request, not global counter", outcome.value.id === "h:request:" + req.hash);
  ok("unrelated earlier start preserves existing syscall result", merged.rejected.length === 0 && merged.syscalls.length === 1 && JSON.stringify(merged.syscalls[0].outcome) === JSON.stringify(old.syscalls[0].outcome));
  ok("unrelated earlier start preserves process object IDs", JSON.stringify(merged.kernel.getProcess(pid)) === JSON.stringify(old.kernel.getProcess(pid)));
  ok("merged history delivery permutations converge", await merged.kernel.stateDigest() === await reverse.kernel.stateDigest());
  const k = new QosKernel();
  assert.ok(k.createProcess({name:"reserved",owner:"a",pid:"proc:1"}).ok);
  const auto = k.createProcess({name:"auto",owner:"a"});
  ok("automatic PIDs skip existing explicit allocations", auto.ok && auto.value.pid === "proc:2");
}
// Version receipts bind to a specific handle state, not just any existing hash.
{
  const roomId = "cap:room:03010563656127610341634101250325";
  const room = new QosProcessRoom({roomId,identity:await newDynCapState(new Uint8Array(32).fill(94)),transport:{broadcast:()=>{}}});
  const start = await room.startProcess("versioned",{entropyHex:"ae"});
  const pid = start.processId;
  const replay = () => replayQosKernel(room.log.events());
  const root = replay().kernel.getProcess(pid).root;
  const call = async (op,args) => {
    const payload = {schema:"qos.syscall/1",caller:pid,op,args};
    const req = await room.emit(pid,start.event,"syscall-request",payload);
    const outcome = previewCanonicalSyscall(replay().kernel,payload,pid,req.hash);
    const result = await room.emit(pid,start.event,"syscall-result",{schema:"qos.syscall/1",requestHash:req.hash,outcome});
    return {req,result,outcome};
  };
  const derived = await call("cap_derive",{handle:root,rights:R.READ,handleVersion:start.event.hash});
  const handle = derived.outcome.value.id;
  ok("new handle version is its verified result hash",replay().kernel.handleVersion(pid,handle) === derived.result.hash);
  const closed = await call("cap_close",{handle,handleVersion:derived.result.hash});
  ok("closed handle retains last mutation receipt",replay().kernel.handleVersion(pid,handle) === closed.result.hash);
  const refusal = await call("cap_close",{handle,handleVersion:closed.result.hash});
  ok("current tombstone version produces deterministic EBADF",!refusal.outcome.ok && refusal.outcome.errno === "EBADF" && replay().rejected.length === 0);
  const before = await replay().kernel.stateDigest();
  const stale = await room.emit(pid,start.event,"syscall-request",{schema:"qos.syscall/1",caller:pid,op:"cap_close",args:{handle,handleVersion:derived.result.hash}});
  ok("stale version cannot act on tombstone",replay().rejected.some(e => e.hash === stale.hash && e.reason.includes("stale")));
  const missing = await room.emit(pid,start.event,"syscall-request",{schema:"qos.syscall/1",caller:pid,op:"cap_close",args:{handle,handleVersion:"f".repeat(64)}});
  const after = replay();
  ok("unknown version edge is explicit missing dependency",after.missingDependencies.some(e => e.eventHash === missing.hash && e.kind === "handle-version"));
  ok("invalid version histories do not mutate verified state",await after.kernel.stateDigest() === before);
  const reverse = replayQosKernel([...room.log.events()].reverse());
  ok("version conflicts and state converge across delivery permutations",JSON.stringify(after.rejected) === JSON.stringify(reverse.rejected) && await after.kernel.stateDigest() === await reverse.kernel.stateDigest());
}
// Cross-process SIGNAL is granted by the target, never by arbitrary room-root open.
{
  const roomId = "cap:room:03010563656127610341634101250325";
  const identities = await Promise.all([101,102].map(n => newDynCapState(new Uint8Array(32).fill(n))));
  identities.sort((a,b) => a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0);
  const make = identity => new QosProcessRoom({roomId,identity,transport:{broadcast:()=>{}}});
  const donor = make(identities[0]), receiver = make(identities[1]);
  const d = await donor.startProcess("signal-target",{entropyHex:"ad"});
  const r = await receiver.startProcess("signal-recipient",{entropyHex:"ae"});
  await donor.log.mergeFrom(receiver.log); await receiver.log.mergeFrom(donor.log);
  const replay = room => replayQosKernel(room.log.events(),room.log.forkedSources);
  const rootD = replay(donor).kernel.getProcess(d.processId).root;
  const rootR = replay(receiver).kernel.getProcess(r.processId).root;
  async function call(room, start, op, input) {
    const k = replay(room).kernel, pid = start.processId, args = {...input};
    if (typeof args.handle === "string" && k.handleVersion(pid,args.handle)) args.handleVersion = k.handleVersion(pid,args.handle);
    if (typeof args.target === "string") args.targetVersion = k.processVersion(args.target);
    const payload = {schema:"qos.syscall/1",caller:pid,op,args};
    const request = await room.emit(pid,start.event,"syscall-request",payload);
    assert.ok(replay(room).pendingSyscalls.includes(request.hash), op+" request not admitted");
    const outcome = previewCanonicalSyscall(replay(room).kernel,payload,pid,request.hash);
    assert.ok(outcome);
    const result = await room.emit(pid,start.event,"syscall-result",{schema:"qos.syscall/1",requestHash:request.hash,outcome});
    assert.ok(replay(room).syscalls.some(t => t.resultHash === result.hash), op+" result not replayed");
    return {request,result,outcome};
  }
  const denied = await call(receiver,r,"signal",{handle:rootR,target:d.processId,signal:"SIGKILL"});
  ok("own room root cannot signal another process", errno(denied.outcome) === "EACCES");
  const grant = await call(donor,d,"signal_grant",{handle:rootD,target:r.processId});
  assert.ok(grant.outcome.ok);
  const {handle,revoker} = grant.outcome.value;
  ok("target consent issues only a target-bound SIGNAL handle", handle.rights === R.SIGNAL && handle.object === "proc:"+d.processId && handle.id === "h:signal:"+grant.request.hash);
  ok("grant retains a revocable parent in target namespace", revoker.id === handle.parent && (revoker.rights & R.REVOKE) !== 0);
  await receiver.log.mergeFrom(donor.log);
  ok("grant result is recipient handle version", replay(receiver).kernel.handleVersion(r.processId,handle.id) === grant.result.hash);
  const revoked = await call(donor,d,"cap_revoke",{handle:revoker.id});
  assert.ok(revoked.outcome.ok);
  await receiver.log.mergeFrom(donor.log);
  ok("revocation reaches recipient's handle and updates its version", revoked.outcome.value === 2 && replay(receiver).kernel.handleVersion(r.processId,handle.id) === revoked.result.hash);
  const refused = await call(receiver,r,"signal",{handle:handle.id,target:d.processId,signal:"SIGKILL"});
  ok("revoked SIGNAL cannot control target", errno(refused.outcome) === "EACCES");
  const fresh = await call(donor,d,"signal_grant",{handle:rootD,target:r.processId});
  assert.ok(fresh.outcome.ok);
  await receiver.log.mergeFrom(donor.log);
  const kill = await call(receiver,r,"signal",{handle:fresh.outcome.value.handle.id,target:d.processId,signal:"SIGKILL"});
  ok("explicit live granted handle permits signal", kill.outcome.ok);
  const state = replay(receiver);
  ok("signal terminates target and clears its handles", state.kernel.getProcess(d.processId)?.state === "exited" && state.kernel.getProcess(d.processId)?.handles.length === 0);
  ok("signal result stamps target lifecycle version",state.kernel.processVersion(d.processId) === kill.result.hash);
  const events = receiver.log.events();
  const reverse = new QosEventLog(roomId);
  for (const event of [...events].reverse()) assert.ok((await reverse.ingest(event)).ok);
  const other = replayQosKernel(reverse.events(),reverse.forkedSources);
  ok("cross-process delivery permutations converge", state.rejected.length === 0 && other.rejected.length === 0 && await state.kernel.stateDigest() === await other.kernel.stateDigest() && JSON.stringify(state.syscalls) === JSON.stringify(other.syscalls));
  const gap = replayQosKernel(events.filter(e => e.hash !== fresh.result.hash));
  ok("missing grant receipt prevents dependent signal",gap.kernel.getProcess(d.processId)?.state === "running" && gap.missingDependencies.some(e => e.kind === "handle-version" && e.dependencyHash === fresh.result.hash));
  const stale = await receiver.emit(r.processId,r.event,"syscall-request",{schema:"qos.syscall/1",caller:r.processId,op:"signal",args:{handle:fresh.outcome.value.handle.id,handleVersion:fresh.result.hash,target:d.processId,targetVersion:d.event.hash,signal:"SIGTERM"}});
  ok("old target lifecycle receipt cannot be replayed after signal",replay(receiver).rejected.some(e=>e.hash===stale.hash && e.reason.includes("stale")));
}
// Suspended children are active, not reaped by wait.
{
  const {k,init} = bootstrap();
  const img = k.open(init.pid,"image:shell",R.EXEC|R.GRANT).value;
  const child = k.spawn(init.pid,img.id,"sleeping").value;
  assert.ok(k.replayLifecycle(child.pid,"suspend").ok);
  ok("wait cannot reap a suspended child",errno(k.wait(init.pid,child.pid))==="EAGAIN");
  ok("suspended child remains suspended",k.getProcess(child.pid)?.state==="suspended");
  const ctl = k.open(init.pid,"proc:"+child.pid,R.SIGNAL).value;
  ok("explicit SIGNAL can terminate suspended target",k.signal(init.pid,child.pid,"SIGTERM",ctl.id).ok && k.getProcess(child.pid)?.handles.length===0);
}
// --- deterministic replay -------------------------------------------------
{
  const run = async () => {
    const k = new QosKernel();
    const a = k.createProcess({ name: "init", owner: "anchor:alice" });
    const img = k.open(a.value.pid, "image:shell", R.READ | R.EXEC | R.GRANT, a.value.root);
    const child = k.spawn(a.value.pid, img.value.id, "worker");
    const h = k.open(a.value.pid, `proc:${child.value.pid}`, R.SIGNAL, a.value.root);
    k.signal(a.value.pid, child.value.pid, "SIGTERM");
    k.wait(a.value.pid, child.value.pid);
    k.exit(a.value.pid, 0);
    return k.stateDigest();
  };
  const d1 = await run();
  const d2 = await run();
  ok("same operations produce the same digest", d1 === d2, `${d1} != ${d2}`);
  const k = new QosKernel();
  const other = k.createProcess({ name: "different", owner: "anchor:bob" });
  const d3 = await k.stateDigest();
  ok("different operations produce a different digest", d3 !== d1);
  ok("digest is 64 hex chars", /^[0-9a-f]{64}$/.test(d1), d1);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: qos-kernel.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
