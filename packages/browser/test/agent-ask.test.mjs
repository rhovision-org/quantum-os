// agent-ask.test.mjs — `/ask` agent selection.
//
//   node packages/browser/test/agent-ask.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `export { pickAskAgent, agentAskText, agentCommand } from "./src/agent-ask.ts";`,
    resolveDir: root,
    loader: "ts",
    sourcefile: "agent-ask-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { pickAskAgent, agentAskText, agentCommand } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

// Facilitator wins even when a different agent would sort first.
const fac = pickAskAgent([
  ["cap:peer:aaa", "scribe"],
  ["cap:peer:zzz", "facilitator"],
]);
ok("facilitator wins over a lower peer id", fac?.role === "facilitator" && fac.peerId === "cap:peer:zzz", JSON.stringify(fac));

// No facilitator: deterministic lowest peer id.
const other = pickAskAgent([
  ["cap:peer:zzz", "skeptic"],
  ["cap:peer:aaa", "scribe"],
]);
ok("no facilitator falls back to the lowest peer id", other?.peerId === "cap:peer:aaa" && other.role === "scribe", JSON.stringify(other));

// No agents at all.
ok("no agents returns null", pickAskAgent([]) === null);
ok("empty roles are ignored", pickAskAgent([["cap:peer:aaa", ""], ["cap:peer:bbb", "  "]]) === null);

// Case and whitespace are normalised.
const normal = pickAskAgent([["cap:peer:aaa", "  FACILITATOR  "]]);
ok("role is normalised", normal?.role === "facilitator", JSON.stringify(normal));

// The facilitator's command prefix is `facil`; other roles use their own name.
ok("facilitator command is facil", agentCommand("facilitator") === "facil");
ok("scribe command is scribe", agentCommand("scribe") === "scribe");
ok("ask text names the chosen command", agentAskText({ peerId: "p", role: "facilitator" }, "what is /poll?") === "/facil ask what is /poll?");
ok("ask text preserves a multi-word question", agentAskText({ peerId: "p", role: "scribe" }, "summarize this please") === "/scribe ask summarize this please");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: agent-ask.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
