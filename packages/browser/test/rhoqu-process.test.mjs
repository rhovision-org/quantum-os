import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: 'export { processFromCommands, executeRhoProcess, executeRhoProcessWithPollBindings, countRhoProcessCommands } from "./src/rhoqu-process.ts"; export { transpileProcess, evaluateRhoQuRuntimeCondition } from "./src/rhoqu.ts";',
    resolveDir: root,
    loader: "ts",
    sourcefile: "rhoqu-process-test-entry.ts",
  },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { processFromCommands, executeRhoProcess, executeRhoProcessWithPollBindings, countRhoProcessCommands, transpileProcess, evaluateRhoQuRuntimeCondition } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " (" + detail + ")" : "")); }
};
const p = processFromCommands(["/poll new A", "/poll add B", "/lemma done"]);
ok("command array lowers to a sequence IR", p.kind === "sequence" && p.steps.length === 3 && p.steps.every(s => s.kind === "command"));
const order = [];
const result = executeRhoProcess(p, c => { order.push(c); return ["ran:" + c]; });
ok("execution preserves source order", order.join("|") === "/poll new A|/poll add B|/lemma done");
ok("success results preserve command and returned lines", result.length === 3 && result.every(r => r.ok) && result[1].lines[0] === "ran:/poll add B");
const nested = { kind: "sequence", steps: [p.steps[0], { kind: "sequence", steps: [p.steps[1], p.steps[2]] }] };
const nestedOrder = [];
executeRhoProcess(nested, c => { nestedOrder.push(c); return []; });
ok("nested sequences execute deterministically", nestedOrder.join("|") === order.join("|"));
const isolated = executeRhoProcess(p, c => { if (c === "/poll add B") throw new Error("synthetic failure"); return [c]; });
ok("command failure becomes a structured error", isolated[1]?.ok === false && isolated[1]?.error === "synthetic failure");
ok("later commands still execute after failure", isolated[2]?.ok === true);
ok("failed command has no fabricated output", isolated[1]?.lines.length === 0);
const bindingProcess = { kind: "sequence", steps: [
  { kind: "command", command: "/poll new bound", bind: "pollId" },
  { kind: "command", command: "/poll add $pollId" },
  { kind: "command", command: "/poll status $LAST_ID" },
] };
const boundCommands = [];
const boundResults = executeRhoProcess(bindingProcess, command => {
  boundCommands.push(command);
  if (command === "/poll new bound") return { lines: ["created"], id: "poll-real-7f3a" };
  return ["ran:" + command];
});
ok("binding captures actual structured ID", boundResults[0]?.ok && boundResults[0].id === "poll-real-7f3a");
ok("named binding resolves in following command", boundCommands[1] === "/poll add poll-real-7f3a");
ok("LAST_ID resolves to actual ID, not guessed text", boundCommands[2] === "/poll status poll-real-7f3a");
const missingIdCommands = [];
executeRhoProcess(bindingProcess, command => { missingIdCommands.push(command); return ["created but no structured ID"]; });
ok("missing ID never fabricates a binding", missingIdCommands[1] === "/poll add $pollId" && missingIdCommands[2] === "/poll status $LAST_ID");
const failedBindingCommands = [];
const failedBinding = executeRhoProcess(bindingProcess, command => {
  failedBindingCommands.push(command);
  if (command === "/poll new bound") return { lines: ["not created" ] };
  if (command === "/poll add $pollId") throw new Error("add failed");
  return { lines: ["ok"], id: "poll-next-9" };
});
ok("unstructured command output does not bind", failedBindingCommands[1] === "/poll add $pollId");
ok("failed command does not advance LAST_ID", failedBindingCommands[2] === "/poll status $LAST_ID");
ok("failure remains explicit in result", failedBinding[1]?.ok === false && failedBinding[1]?.error === "add failed");
const refreshCommands = [];
executeRhoProcess({ kind: "sequence", steps: [
  { kind: "command", command: "/first", bind: "target" },
  { kind: "command", command: "/second", bind: "target" },
  { kind: "command", command: "/use $target $LAST_ID" },
]}, command => {
  refreshCommands.push(command);
  if (command === "/first") return { lines: [], id: "id-a" };
  if (command === "/second") return { lines: [], id: "id-b" };
  return [];
});
ok("latest successful binding replaces prior value", refreshCommands[2] === "/use id-b id-b");
// Parser-to-dispatch integration: binding syntax reaches the process IR and
// the live adapter captures IDs from the authoritative store, not display text.
const liveProcess = transpileProcess("bind pollId /poll new decision; /poll add $pollId Option A; /poll status $LAST_ID;");
ok("bind syntax produces command IR with named binding", liveProcess.steps.length === 3 && liveProcess.steps[0].bind === "pollId" && liveProcess.steps[0].command === "/poll new decision");
const liveIds = new Set();
const liveCommands = [];
const liveResults = executeRhoProcessWithPollBindings(liveProcess, command => {
  liveCommands.push(command);
  if (command === "/poll new decision") { liveIds.add("poll-real-42"); return ["poll created"]; }
  return ["ran:" + command];
}, () => [...liveIds]);
ok("live dispatcher ID binds following command", liveCommands[1] === "/poll add poll-real-42 Option A");
ok("LAST_ID uses ID returned by live dispatcher", liveCommands[2] === "/poll status poll-real-42");
ok("live integration results remain successful", liveResults.length === 3 && liveResults.every(r => r.ok));
const noCreationIds = new Set();
const noCreationCommands = [];
executeRhoProcessWithPollBindings(liveProcess, command => { noCreationCommands.push(command); return ["no poll created"]; }, () => [...noCreationIds]);
ok("failed poll creation leaves named binding unresolved", noCreationCommands[1] === "/poll add $pollId Option A" && noCreationCommands[2] === "/poll status $LAST_ID");
const runtimeIR = transpileProcess("when peers() >= 2 { /branch-many; } else { /branch-few; }");
ok("runtime when retains both branches in IR", runtimeIR.steps[0]?.kind === "when" && runtimeIR.steps[0]?.then.steps[0]?.command === "/branch-many" && runtimeIR.steps[0]?.else?.steps[0]?.command === "/branch-few");
let peerSnapshot = 1;
const runtimeCommands = [];
const runtimeProcess = { kind: "sequence", steps: [{ kind: "command", command: "/mutate-state" }, ...runtimeIR.steps] };
executeRhoProcess(runtimeProcess, command => { runtimeCommands.push(command); if (command === "/mutate-state") peerSnapshot = 2; return []; }, {
  evaluateWhen: (condition, env) => evaluateRhoQuRuntimeCondition(condition, env, { lemmaNames: [], balances: {}, declaredCurrencies: [], peerCount: peerSnapshot, connected: false, currentSeq: 0 }),
});
ok("runtime condition observes state changed before branch", runtimeCommands.join("|") === "/mutate-state|/branch-many");
const falseBranchCommands = [];
executeRhoProcess(runtimeIR, command => { falseBranchCommands.push(command); return []; }, {
  evaluateWhen: (condition, env) => evaluateRhoQuRuntimeCondition(condition, env, { lemmaNames: [], balances: {}, declaredCurrencies: [], peerCount: 0, connected: false, currentSeq: 0 }),
});
ok("runtime condition selects else branch from snapshot", falseBranchCommands[0] === "/branch-few");
const snapshotLemma = evaluateRhoQuRuntimeCondition({ kind: "call", name: "has", args: [{ kind: "lemma", name: "sample" }] }, {}, { lemmaNames: ["sample"], balances: {}, declaredCurrencies: [], peerCount: 0, connected: false, currentSeq: 0 });
ok("runtime evaluator reads immutable lemma snapshot", snapshotLemma === true);
let reservedBindingRejected = false;
try { transpileProcess("bind LAST_ID /poll new reserved;"); }
catch (error) { reservedBindingRejected = String(error).includes("LAST_ID is reserved"); }
ok("LAST_ID cannot be shadowed by a named binding", reservedBindingRejected);
// Runtime when retains both branches and samples room state only when reached.
const runtimeProcess = transpileProcess("when peers() >= 2 { /grant peer-two; } else { /grant peer-one; }");
ok("runtime when lowers to a typed conditional node", runtimeProcess.steps.length === 1 && runtimeProcess.steps[0].kind === "when");
ok("runtime conditional count includes both branches", countRhoProcessCommands(runtimeProcess) === 2);
const runtimeSnapshot = (peerCount) => ({ lemmaNames: [], balances: {}, declaredCurrencies: [], peerCount, connected: true, currentSeq: 4 });
const runRuntimeBranch = (peerCount) => {
  const executed = [];
  const snap = runtimeSnapshot(peerCount);
  const results = executeRhoProcess(runtimeProcess, command => { executed.push(command); return [command]; }, {
    evaluateWhen: (condition, env) => evaluateRhoQuRuntimeCondition(condition, env, snap),
  });
  return { executed, results };
};
const lowPeers = runRuntimeBranch(1), highPeers = runRuntimeBranch(3);
ok("runtime when selects else from execution snapshot", lowPeers.executed.join() === "/grant peer-one");
ok("runtime when selects then from execution snapshot", highPeers.executed.join() === "/grant peer-two");
ok("same snapshot deterministically selects same branch", runRuntimeBranch(3).executed.join() === highPeers.executed.join());
ok("selected command uses normal interpreter result", highPeers.results.length === 1 && highPeers.results[0].ok && highPeers.results[0].command === "/grant peer-two");
const noEvaluator = executeRhoProcess(runtimeProcess, command => [command]);
ok("runtime when errors explicitly without evaluator", noEvaluator.length === 1 && noEvaluator[0].ok === false && noEvaluator[0].error.includes("snapshot evaluator"));
let legacyWhenRejected = false;
try { transpileProcess("when connected() { /grant online; }"); } catch (error) { legacyWhenRejected = String(error).includes("runtime when cannot be flattened"); }
ok("legacy flat transpile rejects runtime branches", legacyWhenRejected);
const compileContext = { hasLemma: () => false, balance: () => 0, isCurrencyDeclared: () => false, peerCount: () => 1, isConnected: () => true, myCurrentSeq: () => 0 };
const compileIf = transpileProcess("if peers() >= 2 { /grant compile-two; } else { /grant compile-one; }", compileContext);
ok("existing if remains compile-time compatible", compileIf.steps.length === 1 && compileIf.steps[0].kind === "command" && compileIf.steps[0].command === "/grant compile-one");
const parameterBranch = transpileProcess("process Threshold(n) { when peers() >= n { /grant threshold-met; } else { /grant below; } } Threshold(2);");
const parameterCommands = [];
executeRhoProcess(parameterBranch, command => { parameterCommands.push(command); return []; }, { evaluateWhen: (condition, env) => evaluateRhoQuRuntimeCondition(condition, env, runtimeSnapshot(3)) });
ok("runtime branch preserves process parameter environment", parameterCommands.join() === "/grant threshold-met");
console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + ": rhoqu-process.test.mjs — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
