// RhoQu binding syntax -> parser -> process IR -> runtime ID binding integration.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: { contents: 'export { transpileProcess } from "./src/rhoqu.ts"; export { executeRhoProcess } from "./src/rhoqu-process.ts";', resolveDir: root, loader: "ts", sourcefile: "rhoqu-binding-test-entry.ts" },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { transpileProcess, executeRhoProcess } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => { if (condition) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " (" + detail + ")" : "")); } };
const source = "bind pollId /poll new Decision; /poll add $pollId Option A; /poll status $LAST_ID;";
const process = transpileProcess(source);
ok("bind syntax emits binding metadata", process.steps[0]?.command === "/poll new Decision" && process.steps[0]?.bind === "pollId");
const seen = [];
const results = executeRhoProcess(process, command => {
  seen.push(command);
  if (command === "/poll new Decision") return { lines: ["created"], id: "poll-real-41" };
  return ["ok"];
});
ok("executor receives original command", seen[0] === "/poll new Decision");
ok("named binding resolves real poll ID", seen[1] === "/poll add poll-real-41 Option A");
ok("LAST_ID resolves to same structured ID", seen[2] === "/poll status poll-real-41");
ok("all commands execute successfully", results.length === 3 && results.every(r => r.ok));
const noId = [];
executeRhoProcess(transpileProcess("bind missing /poll new NoID; /poll add $missing option;"), command => { noId.push(command); return ["display-only output"] });
ok("missing structured ID leaves binding unresolved", noId[1] === "/poll add $missing option");
console.log("\\n" + (fail === 0 ? "PASS" : "FAIL") + ": rhoqu-binding.test.mjs — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
