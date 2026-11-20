import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: 'export { processFromCommands, executeRhoProcess } from "./src/rhoqu-process.ts";',
    resolveDir: root,
    loader: "ts",
    sourcefile: "rhoqu-process-test-entry.ts",
  },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { processFromCommands, executeRhoProcess } = await import(
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
console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + ": rhoqu-process.test.mjs — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
