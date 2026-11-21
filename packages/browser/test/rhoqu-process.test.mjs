import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: { contents: 'export { processFromCommands, executeRhoProcess, executeRhoProcessAsync, executeRhoProcessWithPollBindings, executeRhoProcessWithStoreBindingsAsync, countRhoProcessCommands } from "./src/rhoqu-process.ts"; export { transpile, transpileProcess, evaluateRhoQuRuntimeCondition } from "./src/rhoqu.ts";', resolveDir: root, loader: "ts", sourcefile: "rhoqu-process-test-entry.ts" },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { processFromCommands, executeRhoProcess, executeRhoProcessAsync, executeRhoProcessWithPollBindings, executeRhoProcessWithStoreBindingsAsync, countRhoProcessCommands, transpile, transpileProcess, evaluateRhoQuRuntimeCondition } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " (" + detail + ")" : "")); }
};
const p = processFromCommands(["/poll new A", "/poll add B", "/lemma done"]);
ok("command array lowers to sequence IR", p.kind === "sequence" && p.steps.length === 3 && p.steps.every(s => s.kind === "command"));
const order = [];
const result = executeRhoProcess(p, c => { order.push(c); return ["ran:" + c]; });
ok("execution preserves source order", order.join("|") === "/poll new A|/poll add B|/lemma done");
ok("success results preserve command and lines", result.length === 3 && result.every(r => r.ok) && result[1].lines[0] === "ran:/poll add B");
const nested = { kind: "sequence", steps: [p.steps[0], { kind: "sequence", steps: [p.steps[1], p.steps[2]] }] };
const nestedOrder = [];
executeRhoProcess(nested, c => { nestedOrder.push(c); return []; });
ok("nested sequences execute deterministically", nestedOrder.join("|") === order.join("|"));
const isolated = executeRhoProcess(p, c => { if (c === "/poll add B") throw new Error("synthetic failure"); return [c]; });
ok("command failure becomes structured error", isolated[1]?.ok === false && isolated[1]?.error === "synthetic failure");
ok("later commands still execute after failure", isolated[2]?.ok === true);
ok("failed command has no fabricated output", isolated[1]?.lines.length === 0);
const bindingProcess = { kind: "sequence", steps: [
  { kind: "command", command: "/poll new bound", bind: "pollId" },
  { kind: "command", command: "/poll add $pollId" },
  { kind: "command", command: "/poll status $LAST_ID" },
]};
const boundCommands = [];
const boundResults = executeRhoProcess(bindingProcess, command => {
  boundCommands.push(command);
  if (command === "/poll new bound") return { lines: ["created"], id: "poll-real-7f3a" };
  return ["ran:" + command];
});
ok("binding captures actual structured ID", boundResults[0]?.ok && boundResults[0].id === "poll-real-7f3a");
ok("named binding resolves following command", boundCommands[1] === "/poll add poll-real-7f3a");
ok("LAST_ID resolves actual ID", boundCommands[2] === "/poll status poll-real-7f3a");
const missingIdCommands = [];
executeRhoProcess(bindingProcess, command => { missingIdCommands.push(command); return ["created but no structured ID"]; });
ok("missing ID never fabricates binding", missingIdCommands[1] === "/poll add $pollId" && missingIdCommands[2] === "/poll status $LAST_ID");
const failedBindingCommands = [];
const failedBinding = executeRhoProcess(bindingProcess, command => {
  failedBindingCommands.push(command);
  if (command === "/poll new bound") return { lines: ["not created"] };
  if (command === "/poll add $pollId") throw new Error("add failed");
  return { lines: ["ok"], id: "poll-next-9" };
});
ok("unstructured output does not bind", failedBindingCommands[1] === "/poll add $pollId");
ok("failed command does not advance LAST_ID", failedBindingCommands[2] === "/poll status $LAST_ID");
ok("binding failure remains explicit", failedBinding[1]?.ok === false && failedBinding[1]?.error === "add failed");
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
const liveProcess = transpileProcess("bind pollId /poll new decision; /poll add $pollId Option A; /poll status $LAST_ID;");
ok("bind syntax emits IR metadata", liveProcess.steps.length === 3 && liveProcess.steps[0].bind === "pollId" && liveProcess.steps[0].command === "/poll new decision");
const liveIds = new Set(), liveCommands = [];
const liveResults = executeRhoProcessWithPollBindings(liveProcess, command => {
  liveCommands.push(command);
  if (command === "/poll new decision") { liveIds.add("poll-real-42"); return ["created"]; }
  return ["ran:" + command];
}, () => [...liveIds]);
ok("live store adapter binds authoritative ID", liveCommands[1] === "/poll add poll-real-42 Option A");
ok("live adapter LAST_ID uses real ID", liveCommands[2] === "/poll status poll-real-42");
ok("live binding results successful", liveResults.length === 3 && liveResults.every(r => r.ok));
const noCreationCommands = [];
executeRhoProcessWithPollBindings(liveProcess, command => { noCreationCommands.push(command); return ["no poll created"]; }, () => []);
ok("no created ID leaves bindings unresolved", noCreationCommands[1] === "/poll add $pollId Option A" && noCreationCommands[2] === "/poll status $LAST_ID");
let reservedBindingRejected = false;
try { transpileProcess("bind LAST_ID /poll new reserved;"); } catch (error) { reservedBindingRejected = String(error).includes("LAST_ID is reserved"); }
ok("LAST_ID cannot be shadowed", reservedBindingRejected);
// Runtime branches retain both sides and use execution-time snapshots.
const runtimeIR = transpileProcess("when peers() >= 2 { /branch-many; } else { /branch-few; }");
ok("runtime when retains both branches", runtimeIR.steps[0]?.kind === "when" && runtimeIR.steps[0]?.then.steps[0]?.command === "/branch-many" && runtimeIR.steps[0]?.else?.steps[0]?.command === "/branch-few");
let peerSnapshot = 1;
const runtimeCommands = [];
executeRhoProcess({ kind: "sequence", steps: [{ kind: "command", command: "/mutate-state" }, ...runtimeIR.steps] }, command => {
  runtimeCommands.push(command); if (command === "/mutate-state") peerSnapshot = 2; return [];
}, { evaluateWhen: (condition, env) => evaluateRhoQuRuntimeCondition(condition, env, { lemmaNames: [], balances: {}, declaredCurrencies: [], peerCount: peerSnapshot, connected: false, currentSeq: 0 }) });
ok("runtime branch observes state changed before evaluation", runtimeCommands.join("|") === "/mutate-state|/branch-many");
const falseBranchCommands = [];
executeRhoProcess(runtimeIR, command => { falseBranchCommands.push(command); return []; }, {
  evaluateWhen: (condition, env) => evaluateRhoQuRuntimeCondition(condition, env, { lemmaNames: [], balances: {}, declaredCurrencies: [], peerCount: 0, connected: false, currentSeq: 0 }),
});
ok("runtime branch selects else from snapshot", falseBranchCommands[0] === "/branch-few");
ok("runtime evaluator reads lemma snapshot", evaluateRhoQuRuntimeCondition({ kind: "call", name: "has", args: [{ kind: "lemma", name: "sample" }] }, {}, { lemmaNames: ["sample"], balances: {}, declaredCurrencies: [], peerCount: 0, connected: false, currentSeq: 0 }) === true);
const noEvaluator = executeRhoProcess(runtimeIR, command => [command]);
ok("runtime when fails closed without evaluator", noEvaluator.length === 1 && noEvaluator[0].ok === false && noEvaluator[0].error.includes("snapshot evaluator"));
let legacyWhenRejected = false;
try { transpile("when connected() { /grant online; }"); } catch (error) { legacyWhenRejected = String(error).includes("runtime when cannot be flattened"); }
ok("legacy flat transpile rejects runtime when", legacyWhenRejected);
const compileContext = { hasLemma: () => false, balance: () => 0, isCurrencyDeclared: () => false, peerCount: () => 1, isConnected: () => true, myCurrentSeq: () => 0 };
const compileIf = transpileProcess("if peers() >= 2 { /grant compile-two; } else { /grant compile-one; }", compileContext);
ok("existing if remains compile-time compatible", compileIf.steps.length === 1 && compileIf.steps[0].kind === "command" && compileIf.steps[0].command === "/grant compile-one");
const parameterProcess = transpileProcess("process Threshold(n) { when peers() >= n { /grant threshold-met; } else { /grant below; } } Threshold(2);");
const parameterCommands = [];
executeRhoProcess(parameterProcess, command => { parameterCommands.push(command); return []; }, { evaluateWhen: (condition, env) => evaluateRhoQuRuntimeCondition(condition, env, { lemmaNames: [], balances: {}, declaredCurrencies: [], peerCount: 3, connected: true, currentSeq: 4 }) });
ok("runtime branch keeps process parameters", parameterCommands.join() === "/grant threshold-met");
// Parallel is a distinct IR node and async branches overlap.
const parallelIR = transpileProcess("parallel { /async one; /async two; }");
ok("parallel source lowers to parallel IR", parallelIR.steps.length === 1 && parallelIR.steps[0].kind === "parallel" && parallelIR.steps[0].branches.length === 2);
let activeAsync = 0, maxAsync = 0;
const asyncCommands = [];
const asyncResults = await executeRhoProcessAsync(parallelIR, async command => {
  activeAsync++; maxAsync = Math.max(maxAsync, activeAsync); asyncCommands.push(command);
  await new Promise(resolve => setTimeout(resolve, 20)); activeAsync--; return [command];
});
ok("parallel branches overlap execution", maxAsync === 2);
ok("parallel results preserve source order", asyncResults.map(r => r.command).join("|") === "/async one|/async two");
ok("parallel commands dispatched successfully", asyncCommands.length === 2 && asyncResults.every(r => r.ok));
// Failure semantics: sibling branches and following sequence commands still run; errors stay structured.
const parallelFailureIR = processFromCommands(["/parallel before"]).steps;
const failureParallel = { kind: "parallel", branches: [
  { kind: "command", command: "/branch fail" },
  { kind: "command", command: "/branch survive" },
]};
const failureOrder = [];
const failureResults = await executeRhoProcessAsync({ kind: "sequence", steps: [...parallelFailureIR, failureParallel, { kind: "command", command: "/after parallel" }] }, async command => {
  failureOrder.push(command); if (command === "/branch fail") throw new Error("branch synthetic failure"); return [command];
});
ok("parallel failure remains structured", failureResults.find(r => r.command === "/branch fail")?.ok === false && failureResults.find(r => r.command === "/branch fail")?.error === "branch synthetic failure");
ok("parallel sibling survives branch failure", failureResults.find(r => r.command === "/branch survive")?.ok === true);
ok("sequence continues after parallel failure", failureOrder.includes("/after parallel") && failureResults.at(-1)?.command === "/after parallel");
let activeSequential = 0, maxSequential = 0;
await executeRhoProcessAsync(processFromCommands(["/async first", "/async second"]), async command => {
  activeSequential++; maxSequential = Math.max(maxSequential, activeSequential);
  await new Promise(resolve => setTimeout(resolve, 20)); activeSequential--; return [command];
});
ok("sequential commands do not overlap", maxSequential === 1);

const asyncBindProcess = transpileProcess("bind pollId /poll new async; /poll status $pollId;");
const asyncPollIds = new Set(), asyncBoundCommands = [];
const asyncBoundResults = await executeRhoProcessWithStoreBindingsAsync(asyncBindProcess, async command => {
  asyncBoundCommands.push(command); if (command === "/poll new async") asyncPollIds.add("async-poll-real-55"); return ["created"];
}, command => command === "/poll new async" ? [...asyncPollIds] : []);
ok("async store adapter captures actual ID", asyncBoundResults.length === 2 && asyncBoundResults.every(r => r.ok) && asyncBoundCommands[1] === "/poll status async-poll-real-55");
console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + ": rhoqu-process.test.mjs — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
