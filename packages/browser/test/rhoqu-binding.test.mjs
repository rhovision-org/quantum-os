// RhoQu binding syntax -> parser -> process IR -> runtime ID binding integration.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: { contents: 'export { transpileProcess } from "./src/rhoqu.ts"; export { executeRhoProcessWithStoreBindings, executeRhoProcessWithPollBindings } from "./src/rhoqu-process.ts";', resolveDir: root, loader: "ts", sourcefile: "rhoqu-binding-test-entry.ts" },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { transpileProcess, executeRhoProcessWithPollBindings, executeRhoProcessWithStoreBindings } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => { if (condition) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " (" + detail + ")" : "")); } };
const source = "bind pollId /poll new Decision; /poll add $pollId Option A; /poll status $LAST_ID;";
const rhoProcess = transpileProcess(source);
ok("bind syntax emits binding metadata", rhoProcess.steps[0]?.command === "/poll new Decision" && rhoProcess.steps[0]?.bind === "pollId");
const seen = [];
const pollIds = new Set();
const results = executeRhoProcessWithPollBindings(rhoProcess, command => {
  seen.push(command);
  if (command === "/poll new Decision") { pollIds.add("poll-real-41"); return ["created"]; }
  return ["ok"];
}, () => [...pollIds]);
ok("executor receives original command", seen[0] === "/poll new Decision");
ok("named binding resolves real poll ID", seen[1] === "/poll add poll-real-41 Option A");
ok("LAST_ID resolves to same structured ID", seen[2] === "/poll status poll-real-41");
ok("all commands execute successfully", results.length === 3 && results.every(r => r.ok));
const noId = [];
executeRhoProcessWithPollBindings(transpileProcess("bind missing /poll new NoID; /poll add $missing option;"), command => { noId.push(command); return ["display-only output"]; }, () => []);
ok("missing structured ID leaves binding unresolved", noId[1] === "/poll add $missing option");
// Authoritative-store integration for the remaining synchronous ID-producing commands.
for (const scenario of [
  { label: "lemma", source: "bind lemmaId /lemma bind-lemma; /forget lemma $lemmaId;", create: "/lemma bind-lemma", expected: "/forget lemma lemma-real-9", id: "lemma-real-9", store: new Set(), match: /^\/lemma\b/ },
  { label: "note grant", source: "bind noteId /note grant USD 5; /note split $noteId 1;", create: "/note grant USD 5", expected: "/note split note-real-8 1", id: "note-real-8", store: new Set(), match: /^\/note\s+grant\b/ },
  { label: "rdv swap", source: "bind rdvId /rdv swap USD 5 EUR 4 Bob; /rdv accept $rdvId;", create: "/rdv swap USD 5 EUR 4 Bob", expected: "/rdv accept rdv-real-6", id: "rdv-real-6", store: new Set(), match: /^\/rdv\s+swap\b/ },
]) {
  const process = transpileProcess(scenario.source);
  const commands = [];
  executeRhoProcessWithStoreBindings(process, command => {
    commands.push(command);
    if (command === scenario.create) scenario.store.add(scenario.id);
    return ["dispatched"];
  }, command => scenario.match.test(command) ? [...scenario.store] : []);
  ok(`${scenario.label} binding resolves captured store ID`, commands.length === 2 && commands[1] === scenario.expected);
}
console.log("\\n" + (fail === 0 ? "PASS" : "FAIL") + ": rhoqu-binding.test.mjs — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
