// e2e: fork an agent from room A into room B, with the owner's grant.
//
// In-process relay + the real agent.mjs in room A (greeter, stub AI provider by
// path, so no key and no network) started with an owner capability. Then:
//   1. a non-owner asks for a grant → refused;
//   2. the owner asks (a direct agent-ctl envelope) → gets cap:fork:…;
//   3. a requester who is NOT in room A joins the grant's inbox and asks for a
//      copy in room B → a real child agent.mjs process joins room B;
//   4. the copy says it is a copy, and carries none of room A's chat;
//   5. the owner revokes with stop → the copy's process ends.
// Run: node fork.e2e.mjs
import { startRelay } from "./mini-relay.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";

const PORT = 4463;
const SIGNAL = `ws://127.0.0.1:${PORT}`;
const ROOM_A = generateCapability("room");
const ROOM_B = generateCapability("room");
const OWNER = generateCapability("owner");
const { wss } = startRelay(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "fork-e2e-"));
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };
const until = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(250); } return null; };

const stub = join(dir, "stub-provider.mjs");
writeFileSync(stub, `export default { name: "stub", describe: "test", keyEnv: null, defaultModel: "s",
  unavailable() { return null; }, async complete() { return { text: "stub" }; } };`);

process.env.QOS_AGENT_OWNER = OWNER;
const { run } = await import("./agent.mjs");
const stateA = join(dir, "state");
run({ signal: SIGNAL, room: ROOM_A, role: "greeter", state: stateA, ai: true, aiBackend: stub, skills: ["twenty-questions"] })
  .catch((e) => { console.error("agent crashed:", e); process.exit(1); });

const mkPeer = (roomId, onMessage, extra = {}) => {
  const p = new QOSPeer({ signalingUrl: SIGNAL, roomId, peerId: generateCapability("peer"), noAutoTurn: true, onMessage, onError: () => {}, ...extra });
  p.connect();
  return p;
};

// Room A: the owner, who says something the copy must never learn.
let agentA = null;
const ctlReplies = [];
const owner = mkPeer(ROOM_A, (from, d) => {
  if (d?.kind === "name" && d.agent) agentA = from;
  if (d?.kind === "agent-ctl-reply") ctlReplies.push(d);
});

// Room B: someone who never joins room A.
const inB = [];
let copyId = null;
const watcher = mkPeer(ROOM_B, (from, d) => {
  if (d?.kind === "name" && d.agent) copyId = from;
  if (d?.kind === "chat") inB.push(String(d.text ?? ""));
});

let pid = null;
try {
  ok(!!(await until(() => agentA)), "the agent announced itself in room A");
  delete process.env.QOS_AGENT_OWNER;   // read at start-up; a copy must not inherit it
  owner.broadcast({ kind: "chat", text: "secret plan: the launch date is friday" });
  await sleep(300);

  owner.send(agentA, { kind: "agent-ctl", op: "grant", owner: generateCapability("owner") });
  const refused = await until(() => ctlReplies.shift());
  ok(refused && !refused.ok, `a stranger's owner cap gets no grant  — ${refused?.text}`);

  owner.send(agentA, { kind: "agent-ctl", op: "grant", owner: OWNER, uses: 1, days: 1 });
  const granted = await until(() => ctlReplies.shift());
  ok(granted?.ok && /^cap:fork:/.test(granted.token ?? ""), `the owner gets a fork grant  — ${granted?.text}`);

  // The requester: joins only the grant's inbox, asks for a copy in room B.
  let forkReply = null;
  const requester = mkPeer(granted.token, (_from, d) => { if (d?.kind === "fork-reply") forkReply = d; }, {
    onPeerReady: (id) => requester.send(id, { kind: "fork-request", room: ROOM_B, signal: SIGNAL, name: "Quizzer" }),
  });
  await until(() => forkReply, 80);
  ok(forkReply?.ok, `the request through the grant's inbox is accepted  — ${forkReply?.text}`);
  requester.disconnect();

  ok(!!(await until(() => copyId, 120)), "a copy of the agent joined room B");
  watcher.broadcast({ kind: "name", name: "Bea" });
  const intro = await until(() => inB.find((t) => /copy of an agent from another room/.test(t)), 60);
  ok(!!intro, "the copy says it is a copy");
  watcher.broadcast({ kind: "chat", text: "/greeter skills" });
  ok(!!(await until(() => inB.find((t) => /twenty-questions\*\* \(on\)/.test(t)), 60)), "the copy carries the skill it was started with");
  watcher.broadcast({ kind: "chat", text: "/greeter list 50" });
  await sleep(2500);
  ok(!inB.some((t) => /launch date/.test(t)), "the copy carries none of room A's chat");

  const grants = JSON.parse(readFileSync(join(stateA, "fork-grants.json"), "utf8"));
  pid = Object.values(grants.grants)[0]?.forks?.[0]?.pid;
  ok(Number.isInteger(pid), `the grant records the copy's process (${pid})`);

  owner.send(agentA, { kind: "agent-ctl", op: "revoke", owner: OWNER, id: granted.id, stop: true });
  const revoked = await until(() => ctlReplies.shift());
  ok(revoked?.ok && /stopped 1/.test(revoked.text), `revoke with stop  — ${revoked?.text}`);
  const gone = await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 40);
  ok(!!gone, "the copy's process ended");
} finally {
  if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  try { owner.disconnect(); watcher.disconnect(); } catch {}
  try { wss.close(); } catch {}
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILED` : "\nfork e2e: all passed");
  process.exit(fail ? 1 : 0);
}
