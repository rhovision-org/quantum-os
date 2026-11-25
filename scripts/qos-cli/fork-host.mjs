// fork-host.mjs — let someone in ANOTHER room fork your agent into theirs.
//
// The owner of an agent (whoever added it: the browser that ran `/agent add`
// holds the owner capability, and so does the computer running it) asks the
// agent for a **fork grant**: a `cap:fork:…` token. Whoever holds the grant can
// have a copy of the agent join their own room, from that room, without ever
// being in the owner's room.
//
//   owner's room:   /agent grant facilitator uses 3 days 7   → cap:fork:…
//   another room:   /agent fork cap:fork:…                     → a copy joins
//
// How the request reaches the agent without the owner's room: the grant token
// IS a room capability. The agent listens in the room named by each live grant
// (an "inbox"), so only someone holding the grant can reach it, and the
// signaling server sees only SHA-256 of the token, like any room. The requester's
// browser joins that inbox for a moment and sends its own room link.
//
// What a fork carries (Jim's call, 2026-11-25): the role, the skills and the AI
// provider. NOT the owner's room — no memory, no chat, no lemmas. A fork runs on
// the owner's computer and AI account, so the grant's use limit and expiry are
// what bound the cost, and revoking with stop removes the copies.
//
// Pure where it can be (grant arithmetic, request validation); the I/O — peers,
// processes, files — is injected so fork-host.selftest.mjs needs no network.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { generateCapability, validateCapability } from "./zfa.mjs";

export const MAX_ACTIVE_GRANTS = 10;
export const MAX_USES = 20;
export const MAX_DAYS = 30;
export const DEFAULT_USES = 1;
export const DEFAULT_DAYS = 7;
const DAY_MS = 86_400_000;
export let CLOSE_GRACE_MS = 2_000;
export const _setCloseGrace = (ms) => { CLOSE_GRACE_MS = ms; };
const NAME_RE = /^[A-Za-z][A-Za-z0-9 ._-]{0,31}$/;

export const sha256hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const grantIdOf = (token) => sha256hex(token).slice(0, 8);
export const isForkToken = (s) => typeof s === "string" && /^cap:fork:[0-7]+$/.test(s) && validateCapability(s);
export const isOwnerToken = (s) => typeof s === "string" && /^cap:owner:[0-7]+$/.test(s) && validateCapability(s);

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** A fresh grant. `uses` = how many forks it may make; `days` until it stops making them. */
export function makeGrant({ uses, days, now = Date.now(), token = generateCapability("fork") } = {}) {
  const u = clampInt(uses, 1, MAX_USES, DEFAULT_USES);
  const d = clampInt(days, 1, MAX_DAYS, DEFAULT_DAYS);
  return { id: grantIdOf(token), token, uses: u, used: 0, created: now, expires: now + d * DAY_MS, revoked: false, forks: [] };
}

/** Why a grant can make no more forks, or null when it still can. */
export function grantProblem(g, now = Date.now()) {
  if (!g) return "unknown grant";
  if (g.revoked) return "revoked by its owner";
  if (now >= g.expires) return "expired";
  if (g.used >= g.uses) return `used up (${g.used} of ${g.uses})`;
  return null;
}

/** The room capability a request names, or null. Accepts a bare cap or a full room link. */
export function roomFromRequest(s) {
  if (typeof s !== "string" || s.length > 600) return null;
  let cap = s;
  if (!s.startsWith("cap:")) {
    const m = /room=([^&\s]+)/.exec(s.includes("#") ? s.slice(s.indexOf("#") + 1) : s);
    if (!m) return null;
    try { cap = decodeURIComponent(m[1]); } catch { return null; }
  }
  return /^cap:room:[0-7]+$/.test(cap) && validateCapability(cap) ? cap : null;
}

/**
 * Check a fork request against its grant and this host. Returns
 * `{ room, name }` to go ahead, or `{ error }` with a reason for the requester.
 */
export function checkRequest(d, g, { signal, now = Date.now(), alive = () => false } = {}) {
  const problem = grantProblem(g, now);
  if (problem) return { error: `this fork grant is ${problem}` };
  const room = roomFromRequest(d?.room);
  if (!room) return { error: "that is not a room link" };
  // The copy joins through THIS agent's signaling server. A request naming
  // another would make the owner's computer open a socket to any address a
  // grant holder types; refuse rather than follow.
  if (d?.signal && d.signal !== signal) return { error: `this agent joins rooms through ${signal}; your room uses ${d.signal}` };
  const roomHash = sha256hex(room).slice(0, 12);
  if (g.forks.some((f) => f.roomHash === roomHash && alive(f.pid))) return { error: "a copy of this agent is already in your room" };
  let name;
  if (d?.name !== undefined && d.name !== "") {
    if (typeof d.name !== "string" || !NAME_RE.test(d.name)) return { error: "a name is up to 32 letters, digits, spaces, '.', '_' or '-', starting with a letter" };
    name = d.name;
  }
  return { room, roomHash, name };
}

/** Compare two hex digests without leaking where they differ. */
function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The host. `makePeer(roomId, onMessage)` returns a connected-on-demand peer
 * ({connect, disconnect, send}); `spawnFork({room, name, grant})` starts a copy
 * and returns `{pid, dir}`; `alive(pid)` / `kill(pid)` manage it.
 */
export function createForkHost({ stateDir, ownerToken = null, signal, makePeer, spawnFork, alive, kill, log = () => {}, now = () => Date.now() }) {
  const grantsPath = path.join(stateDir, "fork-grants.json");
  const ownerPath = path.join(stateDir, "owner.json");
  const read = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
  const write = (p, o) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { mode: 0o600 });   // holds live grant tokens
    fs.renameSync(tmp, p);
  };

  // Only the owner's digest is kept, so the state directory cannot be used to
  // act as the owner. A new owner token (a fresh `/agent add`) replaces it.
  let ownerHash = read(ownerPath, {})?.hash ?? null;
  if (ownerToken) {
    if (!isOwnerToken(ownerToken)) log("QOS_AGENT_OWNER is not an owner capability (cap:owner:…) — ignored");
    else { ownerHash = sha256hex(ownerToken); write(ownerPath, { hash: ownerHash, at: now() }); }
  }

  const state = read(grantsPath, { grants: {} });
  state.grants ??= {};
  const save = () => write(grantsPath, state);
  const inboxes = new Map();   // grant id → peer
  const busy = new Set();      // grant ids with a request in progress

  const isOwner = (token) => !!ownerHash && isOwnerToken(token) && sameHash(sha256hex(token), ownerHash);
  const liveForks = (g) => g.forks.filter((f) => alive(f.pid));
  const summary = (g) => {
    const p = grantProblem(g, now());
    const left = Math.max(0, g.uses - g.used);
    return `${g.id} — ${p ? p : `${left} of ${g.uses} fork${g.uses === 1 ? "" : "s"} left, until ${new Date(g.expires).toISOString().slice(0, 10)}`}`
      + ` · ${liveForks(g).length} running`;
  };

  function openInbox(g) {
    if (inboxes.has(g.id) || grantProblem(g, now())) return;
    const peer = makePeer(g.token, (from, d) => { void onRequest(g.id, peer, from, d); });
    inboxes.set(g.id, peer);
    peer.connect();
    log(`fork inbox open for grant ${g.id}`);
  }
  function closeInbox(id) {
    const p = inboxes.get(id);
    if (!p) return;
    inboxes.delete(id);
    try { p.disconnect(); } catch { /* already gone */ }
    log(`fork inbox closed for grant ${id}`);
  }

  async function onRequest(id, peer, from, d) {
    if (!d || d.kind !== "fork-request") return;
    const answer = (ok, text) => { try { peer.send(from, { kind: "fork-reply", ok, text }); } catch { /* requester left */ } };
    const g = state.grants[id];
    if (busy.has(id)) { answer(false, "another request on this grant is being handled — try again in a moment"); return; }
    const chk = checkRequest(d, g, { signal, now: now(), alive });
    if (chk.error) { answer(false, chk.error); if (grantProblem(g, now())) closeInbox(id); return; }
    busy.add(id);
    try {
      const { pid, dir } = await spawnFork({ room: chk.room, name: chk.name, grant: g });
      g.used += 1;
      g.forks.push({ pid, roomHash: chk.roomHash, at: now(), dir });
      save();
      log(`forked into room ${chk.roomHash} (grant ${id}, pid ${pid})`);
      answer(true, `a copy is joining your room now${chk.name ? ` as ${chk.name}` : ""}. It runs on its owner's computer and AI account; the owner can remove it.`);
      // Let the answer leave before the inbox's socket does.
      if (grantProblem(g, now())) setTimeout(() => { if (grantProblem(state.grants[id], now())) closeInbox(id); }, CLOSE_GRACE_MS);
    } catch (e) {
      answer(false, `the copy could not start: ${e?.message ?? e}`);
    } finally { busy.delete(id); }
  }

  /** An owner command (`agent-ctl`). Returns the reply envelope, or null to ignore. */
  function handleCtl(d) {
    const reply = (ok, text, extra = {}) => ({ kind: "agent-ctl-reply", op: d?.op ?? "?", ok, text, ...extra });
    if (!d || d.kind !== "agent-ctl") return null;
    if (!ownerHash) return reply(false, "this agent was started without an owner, so it gives no fork grants. Add it again with /agent add to be its owner.");
    if (!isOwner(d.owner)) return reply(false, "only this agent's owner can do that");
    const t = now();
    if (d.op === "grant") {
      const active = Object.values(state.grants).filter((g) => !grantProblem(g, t)).length;
      if (active >= MAX_ACTIVE_GRANTS) return reply(false, `already ${active} live grants — revoke one first`);
      const g = makeGrant({ uses: d.uses, days: d.days, now: t });
      state.grants[g.id] = g;
      save();
      openInbox(g);
      return reply(true, `fork grant ${g.id}: ${g.uses} fork${g.uses === 1 ? "" : "s"}, until ${new Date(g.expires).toISOString().slice(0, 10)}`,
        { token: g.token, id: g.id, uses: g.uses, expires: g.expires });
    }
    if (d.op === "grants") {
      const list = Object.values(state.grants).sort((a, b) => b.created - a.created);
      return reply(true, list.length ? list.map(summary).join("\n") : "no fork grants yet", { ids: list.map((g) => g.id) });
    }
    if (d.op === "revoke") {
      const id = String(d.id ?? "").toLowerCase();
      const g = state.grants[id] ?? Object.values(state.grants).find((x) => x.id.startsWith(id) && id.length >= 4);
      if (!g) return reply(false, `no grant ${id}`);
      g.revoked = true;
      closeInbox(g.id);
      let stopped = 0;
      if (d.stop) for (const f of g.forks) if (alive(f.pid)) { try { kill(f.pid); stopped++; } catch { /* gone */ } }
      save();
      return reply(true, `grant ${g.id} revoked — it makes no more copies`
        + (d.stop ? `; stopped ${stopped} running cop${stopped === 1 ? "y" : "ies"}` : `; ${liveForks(g).length} running cop${liveForks(g).length === 1 ? "y keeps" : "ies keep"} running (revoke with stop to remove them)`));
    }
    return reply(false, `unknown request "${d.op}"`);
  }

  return {
    handleCtl,
    get hasOwner() { return !!ownerHash; },
    /** Reopen the inbox of every grant that can still make forks. */
    start() { for (const g of Object.values(state.grants)) openInbox(g); },
    stop() { for (const id of [...inboxes.keys()]) closeInbox(id); },
    _state: state, _inboxes: inboxes,
  };
}
