// fork-host.selftest.mjs — fork grants without a network: minting, owner
// checks, request validation, use limits, expiry, revoke and stop.
//   node scripts/qos-cli/fork-host.selftest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateCapability } from "./zfa.mjs";
import { _setCloseGrace, makeGrant, grantProblem, roomFromRequest, checkRequest, createForkHost, isForkToken, MAX_USES } from "./fork-host.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL  " + m); } };

_setCloseGrace(0);
const ROOM = generateCapability("room");
const SIG = "wss://signal.example";

// ---- grants ----
const g = makeGrant({ uses: 2, days: 1, now: 1000 });
ok(isForkToken(g.token), "a grant is a cap:fork: capability");
ok(g.id === g.id.toLowerCase() && g.id.length === 8, "grant id is 8 hex of its hash");
ok(grantProblem(g, 1000) === null, "a fresh grant can fork");
ok(/expired/.test(grantProblem(g, 1000 + 86_400_000)), "a grant expires after its days");
ok(makeGrant({ uses: 999 }).uses === MAX_USES && makeGrant({ uses: "x" }).uses === 1, "uses are clamped, nonsense gives the default");
ok(/revoked/.test(grantProblem({ ...g, revoked: true }, 1000)), "a revoked grant can't fork");
ok(/used up/.test(grantProblem({ ...g, used: 2 }, 1000)), "a used-up grant can't fork");

// ---- requests ----
ok(roomFromRequest(ROOM) === ROOM, "bare room cap accepted");
ok(roomFromRequest(`https://x.io/quantum-os/#room=${encodeURIComponent(ROOM)}`) === ROOM, "full room link accepted");
ok(roomFromRequest(generateCapability("peer")) === null, "a non-room cap is refused");
ok(roomFromRequest("cap:room:0000") === null, "an invalid room cap is refused");
ok(checkRequest({ room: ROOM, signal: SIG }, g, { signal: SIG, now: 1000 }).room === ROOM, "a good request passes");
ok(/signaling|joins rooms through/.test(checkRequest({ room: ROOM, signal: "ws://127.0.0.1:1" }, g, { signal: SIG, now: 1000 }).error), "a request naming another signaling server is refused");
ok(/name/.test(checkRequest({ room: ROOM, name: "x;rm -rf" }, g, { signal: SIG, now: 1000 }).error ?? ""), "a bad name is refused");
const withFork = { ...g, forks: [{ pid: 42, roomHash: checkRequest({ room: ROOM }, g, { signal: SIG, now: 1000 }).roomHash }] };
ok(/already/.test(checkRequest({ room: ROOM }, withFork, { signal: SIG, now: 1000, alive: (p) => p === 42 }).error ?? ""), "a second copy into the same room is refused while the first runs");

// ---- the host ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-host-"));
const OWNER = generateCapability("owner");
const peers = [];
const running = new Set();
let nextPid = 100;
const mk = (opts = {}) => createForkHost({
  stateDir: dir, ownerToken: OWNER, signal: SIG,
  makePeer: (roomId, onMsg) => { const p = { roomId, onMsg, sent: [], connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; }, send(to, d) { this.sent.push(d); return true; } }; peers.push(p); return p; },
  spawnFork: async () => { const pid = nextPid++; running.add(pid); return { pid, dir: "/tmp/x" }; },
  alive: (pid) => running.has(pid), kill: (pid) => running.delete(pid),
  ...opts,
});
const host = mk();
ok(host.hasOwner, "an owner capability makes the host ownable");
ok(!fs.readFileSync(path.join(dir, "owner.json"), "utf8").includes(OWNER), "only the owner's digest is written to disk");
ok(host.handleCtl({ kind: "agent-ctl", op: "grant", owner: generateCapability("owner") }).ok === false, "someone else's owner cap is refused");
ok(host.handleCtl({ kind: "agent-ctl", op: "grant", owner: "cap:room:x" }).ok === false, "a non-owner cap is refused");
const r = host.handleCtl({ kind: "agent-ctl", op: "grant", owner: OWNER, uses: 1 });
ok(r.ok && isForkToken(r.token), "the owner gets a grant");
const inbox = peers.find((p) => p.roomId === r.token);
ok(inbox?.connected, "the grant's inbox is open, in the room named by the grant");

const ask = async (d) => { inbox.sent.length = 0; inbox.onMsg("req", d); await new Promise((res) => setTimeout(res, 10)); return inbox.sent.at(-1); };
let a = await ask({ kind: "fork-request", room: "nonsense" });
ok(a?.ok === false && /room link/.test(a.text), "a bad room is answered, not forked");
a = await ask({ kind: "fork-request", room: ROOM, signal: SIG, name: "Copy" });
ok(a?.ok === true && running.size === 1, "a good request starts one copy");
ok(!inbox.connected, "a grant with no uses left closes its inbox");
a = await ask({ kind: "fork-request", room: generateCapability("room") });
ok(a?.ok === false && /used up/.test(a.text), "a used-up grant says so");

const r2 = host.handleCtl({ kind: "agent-ctl", op: "grant", owner: OWNER, uses: 3 });
const list = host.handleCtl({ kind: "agent-ctl", op: "grants", owner: OWNER });
ok(list.ok && list.text.split("\n").length === 2, "grants lists both");
const rv = host.handleCtl({ kind: "agent-ctl", op: "revoke", owner: OWNER, id: r.id, stop: true });
ok(rv.ok && running.size === 0, "revoke with stop removes the running copy");
ok(host.handleCtl({ kind: "agent-ctl", op: "revoke", owner: OWNER, id: r2.id }).ok, "revoke without stop works");
ok(!peers.find((p) => p.roomId === r2.token).connected, "a revoked grant's inbox closes");

// A restart keeps grants and owner (from disk), and reopens only live inboxes.
peers.length = 0;
const again = mk({ ownerToken: null });
ok(again.hasOwner, "the owner survives a restart without the env var");
const r3 = again.handleCtl({ kind: "agent-ctl", op: "grant", owner: OWNER, uses: 2 });
peers.length = 0;
const third = mk({ ownerToken: null });
third.start();
ok(peers.length === 1 && peers[0].roomId === r3.token, "restart reopens only the grants that can still fork");
fs.rmSync(dir, { recursive: true, force: true });

console.log(`${fail ? "FAIL" : "PASS"}: fork-host.selftest.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
