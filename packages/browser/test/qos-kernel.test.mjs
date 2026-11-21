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
      export { QosKernel, replayQosKernel, QOS_ABI_VERSION, QOS_RIGHTS, QOS_ALL_RIGHTS, QOS_SYSCALLS, QOS_SIGNALS } from "./src/qos-kernel.ts";
      export { QosProcessRoom } from "./src/qos-process.ts";
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
const { QosKernel, replayQosKernel, QosProcessRoom, newDynCapState, QOS_ABI_VERSION, QOS_RIGHTS, QOS_ALL_RIGHTS, QOS_SYSCALLS, QOS_SIGNALS } = mod;

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
