// e2e: a joiner is handed the conversation the facilitator heard (`sync-chat`).
//
// In-process signaling relay + the real agent.mjs (facilitator) + two peers:
// Ann talks and leaves, then Bob joins — nobody who heard Ann is still here
// except the agent, which hands Bob what was said.
// Run: node history.e2e.mjs
import { startRelay } from "./mini-relay.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";
import { run } from "./agent.mjs";

const PORT = 4461;
const ROOM = generateCapability("room");
const { wss } = startRelay(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = mkdtempSync(join(tmpdir(), "history-e2e-"));
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

run({ signal: `ws://127.0.0.1:${PORT}`, room: ROOM, role: "facilitator", state: stateDir, verbose: false })
  .catch((e) => { console.error("agent crashed:", e); process.exit(1); });

const peerOf = (onMessage) => new QOSPeer({
  signalingUrl: `ws://127.0.0.1:${PORT}`, roomId: ROOM, peerId: generateCapability("peer"),
  onMessage, onError: () => {},
});

let bob = null;
const ann = peerOf(() => {});
try {
  await ann.connect();
  for (let i = 0; i < 60 && ann.channels.size === 0; i++) await sleep(250);
  ok(ann.channels.size > 0, "Ann reached the facilitator");
  await sleep(500);
  ann.broadcast({ kind: "name", name: "Ann" });
  await sleep(300);
  for (const t of ["the budget is due friday", "who owns the slides?"]) { ann.broadcast({ kind: "chat", text: t }); await sleep(200); }
  await sleep(500);
  ann.disconnect();
  await sleep(1000);

  let history = null;
  bob = peerOf((_from, d) => { if (d?.kind === "sync-chat") history = d; });
  await bob.connect();
  for (let i = 0; i < 60 && !history; i++) await sleep(250);

  ok(!!history, "Bob was handed a sync-chat");
  if (history) {
    const lines = Array.isArray(history.lines) ? history.lines : [];
    const texts = lines.map((l) => l.text);
    ok(texts.includes("the budget is due friday") && texts.includes("who owns the slides?"), `Ann's lines are in it — ${JSON.stringify(texts)}`);
    ok(texts.indexOf("the budget is due friday") < texts.indexOf("who owns the slides?"), "oldest first");
    const annLine = lines.find((l) => l.text === "who owns the slides?");
    ok(annLine && annLine.label === "Ann" && typeof annLine.at === "number" && annLine.from.startsWith("cap:peer:"), "each line carries author id, name and time");
    ok(!!history.dyncap, "the envelope is signed by the agent");
  }
} finally {
  try { ann.disconnect(); } catch {}
  try { bob?.disconnect(); } catch {}
  try { wss.close(); } catch {}
  rmSync(stateDir, { recursive: true, force: true });
  await sleep(200);
  console.log(fail ? `\n${fail} FAILED` : "\nhistory e2e: all passed");
  process.exit(fail ? 1 : 0);
}
