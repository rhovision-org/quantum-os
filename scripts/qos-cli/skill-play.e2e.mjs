// e2e: an agent with an activity skill — `/<cmd> skills`, `/<cmd> rules`,
// and `/<cmd> play <move>` reaching the model with the rules and the game so far.
//
// In-process relay + the real agent.mjs (greeter, --skill twenty-questions) with
// a stub AI provider plugin loaded BY PATH (so no key and no network), and one
// driver peer. The stub echoes what it was shown, so the test can check that
// the second move's prompt carries the first move.
// Run: node skill-play.e2e.mjs
import { startRelay } from "./mini-relay.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";
import { run } from "./agent.mjs";

const PORT = 4461;
const ROOM = generateCapability("room");
const { wss } = startRelay(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "skill-e2e-"));
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

const stub = join(dir, "stub-provider.mjs");
writeFileSync(stub, `export default { name: "stub", describe: "test", keyEnv: null, defaultModel: "s",
  unavailable() { return null; },
  async complete({ system, prompt }) {
    const rules = /twenty-questions/.test(system) ? "RULES" : "NORULES";
    const prior = /is it alive/.test(prompt.split("says:")[0]) ? "PRIOR" : "FRESH";
    const move = (prompt.match(/says: "([^"]*)"/) || [])[1] || "?";
    return { text: "STUB " + rules + " " + prior + " move=" + move };
  } };`);

run({ signal: `ws://127.0.0.1:${PORT}`, room: ROOM, role: "greeter", state: join(dir, "state"),
  ai: true, aiBackend: stub, skills: ["twenty-questions"], verbose: false })
  .catch((e) => { console.error("agent crashed:", e); process.exit(1); });

const got = [];
const driver = new QOSPeer({
  signalingUrl: `ws://127.0.0.1:${PORT}`, roomId: ROOM, peerId: generateCapability("peer"),
  onMessage: (_from, d) => { if (d?.kind === "chat") got.push(d.text || ""); },
  onError: () => {},
});
driver.connect();
const waitFor = async (re) => { for (let i = 0; i < 40; i++) { const t = got.find((x) => re.test(x)); if (t) return t; await sleep(250); } return null; };

try {
  for (let i = 0; i < 60 && driver.channels.size === 0; i++) await sleep(250);
  ok(driver.channels.size > 0, "driver connected to the agent");
  driver.broadcast({ kind: "name", name: "Ada" });
  await sleep(500);

  driver.broadcast({ kind: "chat", text: "/greeter skills" });
  ok(!!(await waitFor(/twenty-questions/)), "/greeter skills names the loaded skill");

  driver.broadcast({ kind: "chat", text: "/greeter rules" });
  ok(!!(await waitFor(/📜 \*\*twenty-questions\*\*[\s\S]*game master/)), "/greeter rules posts the rules");

  driver.broadcast({ kind: "chat", text: "/greeter play is it alive?" });
  const first = await waitFor(/^STUB .*move=is it alive\?/);
  ok(!!first, `a move reaches the model  — ${first}`);
  ok(/RULES/.test(first ?? ""), "the model was given the skill's rules");
  ok(/FRESH/.test(first ?? ""), "the first move has no earlier moves");

  await sleep(300);
  driver.broadcast({ kind: "chat", text: "/greeter play is it bigger than a cat?" });
  const second = await waitFor(/^STUB .*move=is it bigger than a cat\?/);
  ok(/PRIOR/.test(second ?? ""), `the second move sees the first  — ${second}`);
} finally {
  try { driver.disconnect(); } catch {}
  try { wss.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  await sleep(200);
  console.log(fail ? `\n${fail} FAILED` : "\nskill-play e2e: all passed");
  process.exit(fail ? 1 : 0);
}
