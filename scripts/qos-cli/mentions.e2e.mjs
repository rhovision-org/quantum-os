// e2e: `@mentions` in plain chat (quantum-os#341) — two robots, one person.
//
// In-process signaling relay + the real agent.mjs twice (skeptic and scribe,
// no AI) + one driver peer named Alice. Checks that each robot reads the same
// unchanged `{kind:"chat"}` text on its own: answers when named, keeps quiet
// when somebody else is, and that `@name` inside a slash command stays a lemma.
// Run: node mentions.e2e.mjs
import { startRelay } from "./mini-relay.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";
import { run } from "./agent.mjs";

const PORT = 4463;
const ROOM = generateCapability("room");
const { wss } = startRelay(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

const dirs = [];
for (const role of ["skeptic", "scribe"]) {
  const state = mkdtempSync(join(tmpdir(), `mention-${role}-`));
  dirs.push(state);
  run({ signal: `ws://127.0.0.1:${PORT}`, room: ROOM, role, state, verbose: false })
    .catch((e) => { console.error(`${role} crashed:`, e); process.exit(1); });
}

const roleOf = new Map();   // peerId -> role, from the agents' name envelopes
let heard = [];             // {role, text}
const driver = new QOSPeer({
  signalingUrl: `ws://127.0.0.1:${PORT}`, roomId: ROOM, peerId: generateCapability("peer"),
  onMessage: (from, d) => {
    if (d?.kind === "name" && typeof d.agent === "string") roleOf.set(from, d.agent);
    if (d?.kind === "chat") heard.push({ role: roleOf.get(from) ?? "?", text: String(d.text ?? "") });
  },
  onError: () => {},
});
driver.connect();

// Say something and collect what each robot answers within `ms`.
async function say(text, ms = 2_500) {
  heard = [];
  driver.broadcast({ kind: "chat", text });
  await sleep(ms);
  return { skeptic: heard.filter((h) => h.role === "skeptic"), scribe: heard.filter((h) => h.role === "scribe") };
}

try {
  for (let i = 0; i < 80 && roleOf.size < 2; i++) await sleep(250);
  ok(roleOf.size === 2, "both robots announced themselves");
  driver.broadcast({ kind: "name", name: "Alice" });
  await sleep(3_500);   // let the self-introductions pass

  let r = await say("We may have a contradiction in the proof.");
  ok(!r.skeptic.length && !r.scribe.length, "an unaddressed remark gets no mention reply");

  r = await say("@skeptic?");
  ok(r.skeptic.some((h) => /I'm here/.test(h.text)), "a bare @skeptic gets the skeptic's presence answer");
  ok(!r.scribe.length, "…and the scribe, not named, stays quiet");

  r = await say("@scribe, what is /poll?");
  ok(r.scribe.some((h) => /\/poll/.test(h.text)), "@scribe with a question gets the scribe's answer");
  ok(!r.skeptic.length, "…and the skeptic stays quiet");

  r = await say("/lemma All men are @skeptic");
  ok(!r.skeptic.length && !r.scribe.length, "@name in a slash command is a lemma, not a mention");

  r = await say("type `@scribe` to reach it, or write to alice@scribe.example");
  ok(!r.skeptic.length && !r.scribe.length, "inline code and an email address are not mentions");

  await sleep(6_500);   // each robot's ask cooldown
  r = await say("@skeptic @scribe, what is /poll?", 3_000);
  ok(r.skeptic.length === 1 && r.scribe.length === 1, "both robots named: each answers once, on its own");

  r = await say("@Alice, what do you think?");
  ok(!r.skeptic.length && !r.scribe.length, "a mention of a person is context for the robots, not a prompt");
} finally {
  try { driver.disconnect(); } catch {}
  try { wss.close(); } catch {}
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await sleep(200);
  console.log(fail ? `\n${fail} FAILED` : "\nmentions e2e: all passed");
  process.exit(fail ? 1 : 0);
}
