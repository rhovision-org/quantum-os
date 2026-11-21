// Isolated syscall trace: replay must reproduce outcomes and kernel digest.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({ stdin: { contents: `export { QosSyscallTrace } from "./src/qos-syscall-journal.ts"; export { canonicalJson, sha256Hex } from "./src/qos-process.ts";`, resolveDir: root, loader: "ts", sourcefile: "qos-syscall-journal-entry.ts" }, bundle: true, format: "esm", platform: "node", write: false });
const { QosSyscallTrace, canonicalJson, sha256Hex } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
let pass = 0, fail = 0;
const ok = (name, condition) => { if (condition) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };
const journal = new QosSyscallTrace();
const init = await journal.invoke({ op: "bootstrap", name: "init", owner: "anchor:test" });
ok("bootstrap process recorded", init.ok && init.value.pid === "proc:1");
const opened = await journal.invoke({ op: "open", caller: "proc:1", object: "file:test", rights: 1, parentHandle: "h:1" });
ok("open succeeds and handle recorded", opened.ok && opened.value.id === "h:2");
const refused = await journal.invoke({ op: "open", caller: "proc:1", object: "file:bad", rights: 128, parentHandle: "h:1" });
ok("refusal recorded as outcome", !refused.ok && refused.errno === "EINVAL");
const entries = journal.list();
const replay = await QosSyscallTrace.replay(entries);
ok("replay accepts all journal entries", replay.accepted.length === entries.length && replay.rejected.length === 0);
ok("replay reproduces final kernel digest", replay.stateDigest === await journal.digest());
const tampered = entries.map(e => ({ ...e })); tampered[1] = { ...tampered[1], outcome: { ok: true, value: "forged" } };
const badReplay = await QosSyscallTrace.replay(tampered);
ok("tampered result is rejected", badReplay.rejected.length > 0);
// Recompute the outer hash: this must reach the semantic checks, not merely fail hash verification.
async function rehash(entry) {
  const { hash: _, ...body } = entry;
  return { ...body, hash: await sha256Hex(canonicalJson(body)) };
}
const prefix = await QosSyscallTrace.replay(entries.slice(0, 1));
const forgedOutcome = await rehash({ ...entries[1], outcome: { ok: false, errno: "EINVAL" } });
const poisonOutcome = await QosSyscallTrace.replay([entries[0], forgedOutcome, entries[1]]);
ok("rehashed wrong outcome rejected", poisonOutcome.rejected[0]?.reason === "recorded outcome differs from execution");
ok("wrong outcome leaves prefix digest unchanged", poisonOutcome.accepted.length === 1 && poisonOutcome.stateDigest === prefix.stateDigest);
const forgedDigest = await rehash({ ...entries[1], stateDigest: "0".repeat(64) });
const poisonDigest = await QosSyscallTrace.replay([entries[0], forgedDigest, entries[2]]);
ok("rehashed wrong digest rejected", poisonDigest.rejected[0]?.reason === "kernel state digest mismatch");
ok("wrong digest leaves prefix digest unchanged", poisonDigest.accepted.length === 1 && poisonDigest.stateDigest === prefix.stateDigest);
const concurrent = new QosSyscallTrace();
await Promise.all([
  concurrent.invoke({ op: "bootstrap", name: "first", owner: "one" }),
  concurrent.invoke({ op: "bootstrap", name: "second", owner: "two" }),
]);
const concurrentEntries = concurrent.list();
ok("concurrent invocations serialized", concurrentEntries.length === 2 && concurrentEntries[0].seq === 1 && concurrentEntries[1].seq === 2 && concurrentEntries[1].prev === concurrentEntries[0].hash);
const concurrentReplay = await QosSyscallTrace.replay(concurrentEntries);
ok("concurrent invocation trace replays", concurrentReplay.accepted.length === 2 && concurrentReplay.stateDigest === await concurrent.digest());
ok("trace is not the qos.syscall payload or canonical event", concurrentEntries.every(e => e.schema === "qos.test-trace/1"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
