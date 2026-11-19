// peer.test.mjs — the retry sweep, which has now been wrong twice.
//
// `peer.ts` decides whether two people in a room can reach each other, and it
// had no test. Both of today's failures live here and both were reported from a
// live room rather than caught: a handshake that failed once was never retried,
// and then the retry redialled attempts that were still negotiating, so slow
// paths (phones) could never finish. Neither needs a browser to reproduce —
// only a clock, a socket and a peer connection, all of which are stubs here.
//
//   node packages/browser/test/peer.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// The ZFA kernel is WASM and irrelevant to connecting; stub it at resolve time.
const stubZfa = {
  name: "stub-zfa",
  setup(b) {
    b.onResolve({ filter: /\.\/zfa\.js$/ }, () => ({ path: "zfa-stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      // Unique per call: two tabs minting the same id would hide the very
      // collision this file is here to rule out.
      contents: "let n = 0;"
              + "export const validateCapability = (t) => typeof t === 'string' && t.startsWith('cap:');"
              + "export const generateCapability = (l) => `cap:${l}:${(++n).toString().padStart(4,'0')}`;",
      loader: "js",
    }));
  },
};

const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "peer.ts")],
  bundle: true, format: "esm", platform: "node", write: false, plugins: [stubZfa],
});

const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

// --- a clock we control ------------------------------------------------------
let now = 1_000_000;
const realNow = Date.now;
provide("Date", new Proxy(Date, { get: (t, k) => (k === "now" ? () => now : Reflect.get(t, k)) }));
const advance = (ms) => { now += ms; };

// --- a socket that never really opens ---------------------------------------
const sent = [];
class FakeWS {
  static OPEN = 1; static CLOSED = 3; static CLOSING = 2;
  constructor() { this.readyState = 1; FakeWS.last = this; }
  send(data) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  addEventListener(n, f) { this[`on${n}`] = f; }
}
provide("WebSocket", FakeWS);

// --- peer connections we can hold in any state -------------------------------
const made = [];
class FakePC {
  static nextCreateOffer = null;
  constructor() {
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.localDescription = null;
    this.remoteDescription = null;
    this.rollbackCalls = 0;
    this.addedIceCandidates = [];
    made.push(this);
  }
  createDataChannel() { return { readyState: "connecting", send() {}, close() {} }; }
  async createOffer() {
    const pending = FakePC.nextCreateOffer;
    FakePC.nextCreateOffer = null;
    return pending ? pending() : { type: "offer", sdp: "a=ice-ufrag:AAAA" };
  }
  async createAnswer() { return { type: "answer", sdp: "a=ice-ufrag:BBBB" }; }
  async setLocalDescription(description) {
    if (description?.type === "rollback") {
      this.rollbackCalls++;
      this.localDescription = null;
      this.signalingState = "stable";
    } else {
      this.localDescription = description;
      this.signalingState = description?.type === "offer" ? "have-local-offer" : "stable";
    }
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState = description?.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate(candidate) {
    if (!this.remoteDescription) throw new Error("remote description is not installed");
    this.addedIceCandidates.push(candidate);
  }
  getSenders() { return []; }
  addTrack() { return {}; }
  close() {
    // A browser fires the state handler on close — that is what made a retry
    // look like the peer leaving — but it does not fire again for a connection
    // that is already closed, and a stub that does recurses through cleanup.
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
}
provide("RTCPeerConnection", FakePC);
provide("RTCSessionDescription", class {});
provide("RTCIceCandidate", class { constructor(init) { Object.assign(this, init); } });

const { QOSPeer, ringSkipNeighbors } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let failed = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};
const offersTo = (id) => sent.filter((m) => m.type === "offer" && m.to === id).length;

// --- the bounded-degree overlay: ring + skip-links ---------------------------
// ringSkipNeighbors is a pure function (see peer.ts) — degree 4 (±1, ±2 in a
// sorted list of everyone present), which degenerates to full mesh for five
// or fewer peers and caps degree at 4 past that, regardless of room size.
{
  for (let n = 1; n <= 5; n++) {
    const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
    for (const id of ids) {
      const nb = ringSkipNeighbors(ids, id);
      check(`n=${n}: "${id}" is connected to every other peer (full mesh)`,
            nb.size === n - 1, `got ${nb.size}, ids=${JSON.stringify([...nb])}`);
    }
  }

  const six = ["a", "b", "c", "d", "e", "f"];
  const nbA = ringSkipNeighbors(six, "a");
  check("n=6: degree is capped at 4, not full mesh (n-1=5)", nbA.size === 4, JSON.stringify([...nbA]));
  check("n=6: the excluded peer is the antipodal one", !nbA.has("d"), JSON.stringify([...nbA]));
  check("n=6: the included peers are the ±1/±2 ring neighbors",
        nbA.has("b") && nbA.has("c") && nbA.has("e") && nbA.has("f"), JSON.stringify([...nbA]));

  const ten = Array.from({ length: 10 }, (_, i) => `p${i}`);
  let allDegree4 = true, allSymmetric = true;
  for (const id of ten) {
    const nb = ringSkipNeighbors(ten, id);
    if (nb.size !== 4) allDegree4 = false;
    for (const other of nb) if (!ringSkipNeighbors(ten, other).has(id)) allSymmetric = false;
  }
  check("n=10: every peer has degree exactly 4", allDegree4, "some peer had a different degree");
  check("n=10: the neighbor relation is symmetric — no coordination message needed",
        allSymmetric, "some pair disagreed about being neighbors");

  check("a lone peer has no neighbors", ringSkipNeighbors(["solo"], "solo").size === 0, "expected none");
}

// --- an identity that survives a phone discarding the tab ---------------------
// sessionStorage is per-tab, which is right, but a mobile browser throws it away
// when it evicts a backgrounded tab — so a phone came back as a NEW peer every
// time and the room filled with ghosts of its previous incarnations.
const session = new Map();
const local = new Map();
provide("sessionStorage", {
  getItem: (k) => session.get(k) ?? null,
  setItem: (k, v) => session.set(k, String(v)),
});
provide("localStorage", {
  getItem: (k) => local.get(k) ?? null,
  setItem: (k, v) => local.set(k, String(v)),
  key: (i) => [...local.keys()][i] ?? null,
  get length() { return local.size; },
});

const first = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("an id is leased when it is minted",
      [...local.keys()].some((k) => k.endsWith(first.peerId)), [...local.keys()].join(","));

session.clear();                       // the phone discarded the tab
advance(60_000);                       // and stayed away long enough
const back = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a tab that comes back reclaims its own id rather than becoming a stranger",
      back.peerId === first.peerId, `${back.peerId} vs ${first.peerId}`);

session.clear();
local.set(`qos-peer-lease:${first.peerId}`, String(now));   // the other tab is alive
const second = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a second tab open at the same time gets its own id",
      second.peerId !== first.peerId, `${second.peerId} vs ${first.peerId}`);
first.disconnect(); back.disconnect(); second.disconnect();

// A stale lease left by a DIFFERENT identity (a recovery, a storage clear, an
// incognito key leak) must not be reclaimed — inheriting it makes every peer
// that TOFU-pinned that id refuse our signed name as an anchor mismatch.
session.clear(); local.clear();
local.set("qos-dyncap-state", JSON.stringify({ seed: "x", anchor: "b".repeat(64) }));
local.set("qos-peer-lease:cap:peer:02460246024602460246024602460246",
          JSON.stringify({ at: now - 60_000, anchor: "a".repeat(64) }));   // someone else's abandoned id
const fresh = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a stale lease under another identity's anchor is not reclaimed",
      fresh.peerId !== "cap:peer:02460246024602460246024602460246", fresh.peerId);
check("the fresh id's own lease records this identity's anchor",
      JSON.parse(local.get(`qos-peer-lease:${fresh.peerId}`)).anchor === "b".repeat(64),
      local.get(`qos-peer-lease:${fresh.peerId}`));
fresh.disconnect();

// But a stale lease under OUR OWN anchor still comes back to us (the common case
// — a phone that dropped the tab, same identity).
session.clear(); local.clear();
local.set("qos-dyncap-state", JSON.stringify({ seed: "x", anchor: "c".repeat(64) }));
local.set("qos-peer-lease:cap:peer:02460246024602460246024602460246",
          JSON.stringify({ at: now - 60_000, anchor: "c".repeat(64) }));
const mineBack = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a stale lease under our own anchor is reclaimed",
      mineBack.peerId === "cap:peer:02460246024602460246024602460246", mineBack.peerId);
mineBack.disconnect();

// --- a peer in a room --------------------------------------------------------
// This peer's id sorts BELOW "zzz…" and above "aaa…", so both the eager and the
// polite path can be exercised against one peer.
const tick = () => new Promise((r) => setTimeout(r, 0));
const deliver = (msg) => FakeWS.last.onmessage?.({ data: JSON.stringify(msg) });

const left = [];
const peer = new QOSPeer({
  signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "mmm",
  onPeerLeft: (id) => left.push(id),
});
await peer.connect();         // derives the room key, then creates the socket
FakeWS.last.onopen?.();
await tick();                 // handlers are attached after the open resolves
check("joining the room is announced", sent.some((m) => m.type === "join"), JSON.stringify(sent));
const joinFrame = sent.find((m) => m.type === "join");
check("the server is told a hash of the room token, never the token",
      /^[0-9a-f]{64}$/.test(joinFrame.roomId) && !joinFrame.roomId.includes("0246"), joinFrame.roomId);

deliver({ type: "peers", peers: ["aaa", "zzz"] });
// The stagger is real time and deliberate: dialling everyone at once makes a
// join cost a burst that grows with the room, which is what the signaling
// server refuses.
await new Promise((r) => setTimeout(r, 700));
check("joining dials everyone already in the room", offersTo("aaa") === 1 && offersTo("zzz") === 1,
      `aaa:${offersTo("aaa")} zzz:${offersTo("zzz")}`);

// --- glare while createOffer is still pending -------------------------------
// makingOffer must cover the async createOffer window. A simultaneous remote
// offer can arrive before the local offer has been installed; in that case the
// connection is still stable, so do NOT send an invalid rollback. Answer the
// remote offer, then discard the stale local offer when createOffer resolves.
{
  const glare = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "a" });
  await glare.connect();
  FakeWS.last.onopen?.();
  await tick();

  let releaseOffer;
  FakePC.nextCreateOffer = () => new Promise((resolve) => { releaseOffer = resolve; });
  const mark = sent.length;
  deliver({ type: "peers", peers: ["b"] });
  const pc = made.at(-1);
  check("a local negotiation marks makingOffer before awaiting createOffer",
        glare.makingOffer.get("b") === true && typeof releaseOffer === "function",
        String(glare.makingOffer.get("b")));

  deliver({ type: "offer", from: "b", sdp: "a=ice-ufrag:REMOTE" });
  await tick(); await tick();
  check("a polite peer answers a colliding offer while signalingState is stable",
        pc.remoteDescription?.type === "offer" && pc.localDescription?.type === "answer",
        JSON.stringify({ remote: pc.remoteDescription?.type, local: pc.localDescription?.type }));
  check("stable-state glare does not attempt an invalid rollback",
        pc.rollbackCalls === 0, String(pc.rollbackCalls));
  check("the remote offer was answered on the signaling channel",
        sent.slice(mark).some((m) => m.type === "answer" && m.to === "b"),
        JSON.stringify(sent.slice(mark).map((m) => m.type)));

  releaseOffer({ type: "offer", sdp: "a=ice-ufrag:LOCAL" });
  await tick(); await tick();
  check("the stale local offer is discarded after the remote offer wins",
        !sent.slice(mark).some((m) => m.type === "offer" && m.to === "b"),
        JSON.stringify(sent.slice(mark).map((m) => m.type)));
  check("makingOffer is cleared after glare resolution",
        glare.makingOffer.get("b") === false, String(glare.makingOffer.get("b")));
  glare.disconnect();
}

// --- trickled ICE may beat the offer / remote description --------------------
{
  const icePeer = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "a" });
  await icePeer.connect();
  FakeWS.last.onopen?.();
  await tick();

  const early = { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", usernameFragment: "REMOTE" };
  const duringSetup = { candidate: "candidate:2 1 udp 1 192.0.2.2 5001 typ host", usernameFragment: "REMOTE" };
  // The first candidate arrives before the peer connection exists.
  deliver({ type: "ice", from: "b", candidate: early });
  icePeer.ensureConnected("b");
  await tick(); await tick();
  const pc = made.at(-1);
  // The second arrives after the PC exists but before its remote description.
  deliver({ type: "ice", from: "b", candidate: duringSetup });
  deliver({ type: "offer", from: "b", sdp: "v=0\r\na=ice-ufrag:REMOTE\r\n" });
  await tick(); await tick(); await tick();
  check("ICE arriving before PC creation is queued and applied after the offer",
        pc.addedIceCandidates.some((c) => c.usernameFragment === "REMOTE" && c.candidate === early.candidate),
        JSON.stringify(pc.addedIceCandidates));
  check("ICE arriving before remoteDescription is also queued and applied",
        pc.addedIceCandidates.some((c) => c.usernameFragment === "REMOTE" && c.candidate === duringSetup.candidate),
        JSON.stringify(pc.addedIceCandidates));

  // A candidate for a new ICE restart may beat its new offer. It must wait for
  // that generation instead of being applied to the old remote description.
  const restarted = { candidate: "candidate:3 1 udp 1 192.0.2.3 5002 typ host", usernameFragment: "NEXT" };
  deliver({ type: "ice", from: "b", candidate: restarted });
  deliver({ type: "offer", from: "b", sdp: "v=0\r\na=ice-ufrag:NEXT\r\n" });
  await tick(); await tick(); await tick();
  const nextPc = made.at(-1);
  check("ICE for a new ufrag waits for the matching restarted offer",
        nextPc !== pc && nextPc.addedIceCandidates.some((c) => c.usernameFragment === "NEXT"),
        JSON.stringify(nextPc.addedIceCandidates));
  check("queued ICE is not applied to the stale ICE generation",
        !pc.addedIceCandidates.some((c) => c.usernameFragment === "NEXT"),
        JSON.stringify(pc.addedIceCandidates));
  icePeer.disconnect();
}

// --- an attempt in flight is left alone --------------------------------------
// This is today's second bug: a connection still negotiating has no open
// channel, and redialling it throws the negotiation away. A phone gathering
// candidates for twenty seconds could never finish.
const before = offersTo("aaa");
advance(30_000);
peer.sweep();
await tick();
check("a connection still negotiating is not redialled", offersTo("aaa") === before,
      `${offersTo("aaa")} vs ${before}`);

// --- until it is clearly stuck ----------------------------------------------
advance(60_000);   // past ATTEMPT_PATIENCE_MS
peer.sweep();
await tick(); await tick();
check("an attempt stuck far too long is retried", offersTo("aaa") === before + 1,
      `${offersTo("aaa")} vs ${before}`);

// --- a failed connection is retried, which is today's first bug --------------
made.forEach((pc) => { pc.connectionState = "failed"; });
const failedAt = offersTo("zzz");
advance(60_000);
peer.sweep();
await tick(); await tick();
check("a failed connection is dialled again", offersTo("zzz") > failedAt,
      `${offersTo("zzz")} vs ${failedAt}`);

// --- a retry is not a departure ----------------------------------------------
// Closing the old connection fires its handlers, which declared the peer gone —
// so every retry manufactured a "left", and the new channel opening
// manufactured a "joined". Peers appeared to flap while nothing had happened.
left.length = 0;
made.forEach((pc) => { pc.connectionState = "failed"; });
advance(200_000);
peer.sweep();
await tick(); await tick();
check("replacing our own connection does not report the peer as gone",
      left.length === 0, JSON.stringify(left));

// --- an ICE failure to a peer still in the room is unreachable, not gone ------
// A cross-network peer with no working TURN never completes a direct handshake.
// Firing "failed" used to call declarePeerGone → onPeerLeft → the app drops them
// from the roster, so the peer VANISHES for everyone who cannot dial them — even
// while their chat still relays through an agent (reported live: "chat works but
// peer not listed"). A peer the signaling server still lists is present: keep
// them (the app marks them ⚠ unreachable) and keep retrying.
left.length = 0;
deliver({ type: "peers", peers: ["aaa", "zzz"] });
await new Promise((r) => setTimeout(r, 700));
made.forEach((pc) => {
  if (pc.connectionState !== "closed") { pc.connectionState = "failed"; pc.onconnectionstatechange?.(); }
});
await tick(); await tick();
check("a peer still in the roster is not reported gone when its connection fails",
      left.length === 0, JSON.stringify(left));
const retryFrom = offersTo("zzz");
advance(600_000);
peer.sweep();
await tick(); await tick();
check("the sweep keeps retrying a failed-but-still-present peer",
      offersTo("zzz") > retryFrom, `${offersTo("zzz")} vs ${retryFrom}`);

// --- but once the server drops them, a failure does declare them gone --------
left.length = 0;
peer.roster = new Set(["zzz"]);
advance(600_000);
peer.sweep();                        // dial zzz → one fresh live pc
await tick(); await tick();
peer.roster.delete("zzz");           // now the server has forgotten zzz
made.forEach((pc) => {
  if (pc.connectionState !== "closed") { pc.connectionState = "failed"; pc.onconnectionstatechange?.(); }
});
await tick(); await tick();
check("a peer no longer in the roster IS reported gone on connection failure",
      left.includes("zzz"), JSON.stringify(left));

// --- both sides retry, and neither waits on the other -------------------------
// Deferring entirely to the lower id assumed the other side also retries, which
// is false whenever builds are mixed — and then nobody dials at all.
const high = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "zzzz" });
await high.connect();
FakeWS.last.onopen?.();
await tick();
deliver({ type: "peers", peers: ["aaaa"] });
await new Promise((r) => setTimeout(r, 700));
const highBefore = offersTo("aaaa");
made.forEach((pc) => { pc.connectionState = "failed"; });
advance(120_000);
high.sweep();
await tick(); await tick();
check("the higher-id peer retries too, rather than waiting to be dialled",
      offersTo("aaaa") > highBefore, `${offersTo("aaaa")} vs ${highBefore}`);

// --- the two rosters can disagree ---------------------------------------------
// A `peers` list replaces this peer's own set wholesale, so somebody the server
// omitted once is dropped here while the room still shows them. Nothing dials
// them, and the room reports a peer no attempt is being made to reach.
deliver({ type: "peers", peers: [] });            // the server forgets somebody
const forgotten = offersTo("aaaa");
advance(200_000);
high.sweep();
await tick(); await tick();
check("a peer dropped from the list is not dialled by the sweep",
      offersTo("aaaa") === forgotten, `${offersTo("aaaa")} vs ${forgotten}`);

high.ensureConnected("aaaa");
await tick(); await tick();
check("but the room can say 'this one, now'", offersTo("aaaa") > forgotten,
      `${offersTo("aaaa")} vs ${forgotten}`);

// --- a peer that left is not chased ------------------------------------------
deliver({ type: "left", peerId: "aaaa" });
const goneAt = offersTo("aaaa");
advance(200_000);
high.sweep();
await tick(); await tick();
// --- a join does not become a burst, and ten peers no longer means ten offers -
// It used to just mean "spread the ten offers over a second" (JOIN_STAGGER_MS
// pacing). Now the overlay means most of the ten were never going to be
// dialled at all — bounded-degree, not full mesh — so the invariant worth
// checking is "no offer to anyone outside the ring/skip target set", which
// holds regardless of exactly how the stagger and MAX_IN_FLIGHT interact.
const roomOfTen = ["bbbb", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"];
// ringSkipNeighbors takes an already-sorted list (targetPeers() sorts before
// calling it) — "p10" sorts before "p2" lexicographically, so this is not
// the order the array was written in.
const tenTargets = ringSkipNeighbors([...roomOfTen].sort(), "bbbb");
check("a room of eleven caps this peer's targets at degree 4, not ten", tenTargets.size === 4,
      JSON.stringify([...tenTargets]));

const many = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "bbbb" });
await many.connect();
FakeWS.last.onopen?.();
await tick();
const before10 = sent.length;   // an index into sent, not an offer count — sent mixes message types
deliver({ type: "peers", peers: roomOfTen.filter((id) => id !== "bbbb") });
await new Promise((r) => setTimeout(r, 700));
const burstOffers = sent.slice(before10).filter((m) => m.type === "offer");
check("the initial burst is staggered, not everyone at once",
      burstOffers.length > 0 && burstOffers.length < 10, `${burstOffers.length} offers`);
check("nothing outside the target set is ever dialled in the initial burst",
      burstOffers.every((m) => tenTargets.has(m.to)), JSON.stringify(burstOffers.map((m) => m.to)));

// Fail the in-flight attempts (the file's own idiom, above) and sweep a few
// times — retries stay bounded to the same target set too, not just the
// first dial. This is the same invariant that matters most: whatever else
// happens on retry, a peer outside the ring/skip neighborhood is never
// dialled — not on the first attempt and not on any later one.
for (let i = 0; i < 3; i++) {
  made.forEach((pc) => { if (pc.connectionState !== "closed") pc.connectionState = "failed"; });
  advance(200_000);
  many.sweep();
  await tick(); await tick();
}
const everDialled = new Set(sent.filter((m) => m.type === "offer" && m.to !== "bbbb").map((m) => m.to)
  .filter((id) => roomOfTen.includes(id)));
check("some target actually got dialled (the invariant below isn't vacuous)",
      everDialled.size > 0, "nobody was ever dialled");
check("and nothing outside the target set is ever dialled, even after retries",
      [...everDialled].every((id) => tenTargets.has(id)), JSON.stringify([...everDialled]));
many.disconnect();

// --- pinning: always reach a peer regardless of ring position -----------------
{
  const pinned = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "pin-a" });
  await pinned.connect();
  FakeWS.last.onopen?.();
  await tick();
  // A big room, and — computed, not guessed by name (the ring wraps around,
  // so naming intuition about "far apart alphabetically" is not reliable) —
  // a peer that genuinely is not one of "pin-a"'s ring/skip targets.
  const bigRoster = ["pin-a", ...Array.from({ length: 20 }, (_, i) => `mid${i}`)];
  const bigTargets = ringSkipNeighbors([...bigRoster].sort(), "pin-a");
  const farTarget = bigRoster.find((id) => id !== "pin-a" && !bigTargets.has(id));
  check("the big room actually has a peer outside pin-a's ring/skip targets to test with",
        typeof farTarget === "string", "every peer was somehow a target");
  deliver({ type: "peers", peers: bigRoster.filter((id) => id !== "pin-a") });
  await new Promise((r) => setTimeout(r, 300));
  const before = offersTo(farTarget);
  check("ring math alone does not connect two peers far apart in a big room",
        before === 0, `${before} offers already`);
  pinned.pinNeighbor(farTarget);
  await tick();
  check("pinning dials immediately, bypassing ring position",
        offersTo(farTarget) > before, `${offersTo(farTarget)} vs ${before}`);
  pinned.disconnect();
}

// --- pruning is deliberately disabled: an open connection is never closed --
// just because ring math shifted. Live testing showed why: a roster change
// reshuffles ring positions for EVERYONE, so one flaky peer bouncing in and
// out of the room could cascade into closing other peers' entirely healthy
// connections as a side effect. reconcilePrune is now inert; prunePeer
// (what it used to call) stays correct and tested for a deliberate future
// re-enable behind something better than a fixed per-peer grace timer.
{
  const pruneLeft = [];
  const pruner = new QOSPeer({
    signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "prune-a",
    onPeerLeft: (id) => pruneLeft.push(id),
  });
  // Direct injection: an "open" channel is what reconcilePrune/prunePeer act
  // on, and driving a real handshake to "open" through the stub harness adds
  // nothing this test needs.
  pruner.channels.set("stale-peer", { readyState: "open", send() {}, close() {} });

  // Insert enough peers between them (sorted) to push "stale-peer" past the
  // ±2 ring/skip radius.
  pruner.roster = new Set(["prune-a", "stale-peer", "prune-b", "prune-c", "prune-d",
    ...Array.from({ length: 10 }, (_, i) => `x${i}`)]);
  check("stale-peer is genuinely outside the target set for this roster",
        !pruner.targetPeers().has("stale-peer"), JSON.stringify([...pruner.targetPeers()]));
  pruner.reconcilePrune();
  check("reconcilePrune does NOT arm a close timer, even for a peer outside the target set — disabled by design",
        !pruner.pruneTimers.has("stale-peer"), "a timer got armed despite pruning being off");
  check("...and the channel is still open — nothing closed it",
        pruner.channels.get("stale-peer")?.readyState === "open", "channel got closed");

  // prunePeer itself — no longer auto-triggered, but still correct if called
  // directly (kept for a future re-enable).
  pruner.prunePeer("stale-peer");
  check("prunePeer, called directly, still closes the channel", !pruner.channels.has("stale-peer"),
        "channel still open");
  check("...but does NOT report the peer as gone — they may still be in the room, just not a direct neighbor",
        pruneLeft.length === 0, JSON.stringify(pruneLeft));
  pruner.disconnect();
}

// --- message relay: tag, dedupe, hop-limit, and only the true target ----------
// delivers a directed send() — see peer.ts's broadcast/send/handleRelay.
{
  const relayDelivered = [];
  const cfg = {
    signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "relay-a",
    onMessage: (from, d) => relayDelivered.push({ from, d }),
  };
  const solo = new QOSPeer(cfg);
  const sentTo = new Map();
  const fakeChannel = (id) => ({
    readyState: "open",
    send(payload) { const arr = sentTo.get(id) ?? []; arr.push(JSON.parse(payload)); sentTo.set(id, arr); },
  });
  solo.channels.set("nb1", fakeChannel("nb1"));
  solo.channels.set("nb2", fakeChannel("nb2"));
  solo.roster = new Set(["relay-a", "nb1", "nb2", "far1"]);

  solo.broadcast({ kind: "chat", text: "hi" }, { bulk: true });
  const toNb1 = sentTo.get("nb1")[0];
  check("broadcast tags every neighbor with a dedupe id, hop budget and origin",
        typeof toNb1._relayId === "string" && typeof toNb1._hops === "number" && toNb1._from === "relay-a",
        JSON.stringify(toNb1));
  check("broadcast does not tag a target — that would make it a directed send",
        !("_relayTo" in toNb1), JSON.stringify(toNb1));
  check("the same payload reaches every open neighbor",
        JSON.stringify(sentTo.get("nb2")[0]) === JSON.stringify(toNb1), "mismatch");
  check("the raw kind/text survive tagging unchanged",
        toNb1.kind === "chat" && toNb1.text === "hi", JSON.stringify(toNb1));

  // A peer that reloads restarts its relay counter at 0. Its new ids must NOT
  // collide with the ids it used before the reload — otherwise a peer whose
  // page did not reload has them in seenRelay and silently drops the reloaded
  // peer's first messages (mobile: a tab reloads on every sleep/eviction).
  {
    const rd = [];
    const before = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "rl" });
    const after  = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "rl" }); // same peerId, "reloaded"
    const cap = (n) => { const a = []; return { readyState: "open", sent: a, send: (p) => a.push(JSON.parse(p)) }; };
    const cb = cap(); before.channels.set("x", cb);
    const ca = cap(); after.channels.set("x", ca);
    before.broadcast({ kind: "chat", text: "pre" }, { bulk: true });
    after.broadcast({ kind: "chat", text: "post" }, { bulk: true });
    check("a reloaded peer's first relay id differs from the pre-reload run's",
          ca.sent[0]._relayId !== cb.sent[0]._relayId, `${ca.sent[0]._relayId} vs ${cb.sent[0]._relayId}`);
    const rx = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "rx",
      onMessage: (from, d) => rd.push(d.text) });
    rx.channels.set("z", { readyState: "open", send() {} });
    rx.handleRelay("z", { ...cb.sent[0] });   // pre-reload message
    rx.handleRelay("z", { ...ca.sent[0] });   // post-reload message
    check("both the pre- and post-reload messages are delivered, not deduped",
          rd.length === 2, JSON.stringify(rd));
    before.disconnect(); after.disconnect(); rx.disconnect();
  }

  // Loop the same message back as if nb1 relayed it onward and it reached us
  // again via nb2 — a real ring would do exactly this. Must be dropped, not
  // re-delivered (we already have it) and not re-relayed either.
  sentTo.set("nb1", []); sentTo.set("nb2", []);
  solo.handleRelay("nb2", { ...toNb1, _hops: toNb1._hops - 1 });
  check("a message looping back to its own relay id is dropped, not delivered again",
        relayDelivered.length === 0, JSON.stringify(relayDelivered));
  check("...and not relayed onward either", sentTo.get("nb1").length === 0 && sentTo.get("nb2").length === 0,
        "re-relayed a dupe");

  // A genuinely new flood from someone else, arriving via nb1: delivers once
  // with the true originator (not the last hop), and relays onward only to
  // the OTHER neighbor — never back where it came from.
  solo.handleRelay("nb1", { kind: "chat", text: "from far", _relayId: "far1:1", _hops: 2, _from: "far1" });
  check("a fresh flood delivers with the true originator, not the last hop",
        relayDelivered.length === 1 && relayDelivered[0].from === "far1" && relayDelivered[0].d.text === "from far",
        JSON.stringify(relayDelivered));
  check("...and relays onward to the other neighbor, not back where it came from",
        sentTo.get("nb2").length === 1 && sentTo.get("nb1").length === 0,
        `nb1:${sentTo.get("nb1").length} nb2:${sentTo.get("nb2").length}`);
  check("the relayed copy has no leftover tag fields visible to onMessage",
        !("_relayId" in relayDelivered[0].d) && !("_hops" in relayDelivered[0].d),
        JSON.stringify(relayDelivered[0].d));

  // A bulk send needs a direct channel: megabytes do not flood through
  // neighbors, and never through the relay.
  sentTo.set("nb1", []); sentTo.set("nb2", []);
  const sentOk = solo.send("far-target", { kind: "lib-part", data: "…" }, { bulk: true });
  check("a bulk send() to a peer with no direct channel is refused, not flooded",
        sentOk === false && sentTo.get("nb1").length === 0, `returned ${sentOk}`);

  // A directed relay from an older flood still passes through correctly.
  relayDelivered.length = 0;
  solo.handleRelay("nb1", { kind: "chat", text: "not for me", _relayId: "x:1", _hops: 3, _from: "x", _relayTo: "someone-else" });
  check("a directed relay not addressed to us passes through without delivering here",
        relayDelivered.length === 0, JSON.stringify(relayDelivered));

  // A bulk send to an actual neighbor: raw and untagged on the channel.
  sentTo.set("nb1", []);
  solo.send("nb1", { kind: "lib-part", data: "…" }, { bulk: true });
  check("a bulk send() to a direct neighbor is raw and untagged on the channel",
        JSON.stringify(sentTo.get("nb1")[0]) === JSON.stringify({ kind: "lib-part", data: "…" }),
        JSON.stringify(sentTo.get("nb1")[0]));

  solo.disconnect();
}

// --- the control plane: sealed, relayed, resumable ---------------------------
// Everything that is not media or bulk rides the signaling socket as a `data`
// frame sealed under the room key. This is what makes a room survive a NAT
// that no ICE pair crosses, and a socket blip that used to be a departure.
{
  const { deriveRoomKey, seal, roomIdFor } = await import("../src/room-crypto.js");
  const settle = () => new Promise((r) => setTimeout(r, 30));   // real WebCrypto, real async
  const got = [];
  const ready = [];
  const gone = [];
  const cp = new QOSPeer({
    signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "cp-me",
    onMessage: (from, d) => got.push({ from, d }),
    onPeerReady: (id) => ready.push(id),
    onPeerLeft: (id) => gone.push(id),
  });
  await cp.connect();
  FakeWS.last.onopen?.();
  await tick();
  const sock = FakeWS.last;
  const wire = await roomIdFor("cap:room:0246");
  const key = await deriveRoomKey("cap:room:0246");

  // `sent` is shared with the checks below this block; slice it, never clear it.
  let mark = sent.length;
  const since = () => sent.slice(mark);
  cp.channels.set("nb", { readyState: "open", send() { throw new Error("chat must not go over WebRTC"); } });
  cp.broadcast({ kind: "chat", text: "secret words" });
  cp.send("cp-other", { kind: "name", name: "me" });
  await settle();
  const frames = since().filter((m) => m.type === "data");
  check("a broadcast and a send each leave as one sealed data frame on the socket",
        frames.length === 2 && frames[0].to === undefined && frames[1].to === "cp-other", JSON.stringify(frames));
  check("frames carry the hashed room id and our peerId as from",
        frames.every((f) => f.roomId === wire && f.from === "cp-me"), JSON.stringify(frames));
  check("nothing readable is on the wire",
        !JSON.stringify(frames).includes("secret") && !JSON.stringify(frames).includes("chat"), JSON.stringify(frames));
  check("frames leave in the order they were sent (a name before its sync)", (() => {
    const plain = frames.map((f) => f.to === undefined ? "b" : "s").join("");
    return plain === "bs";
  })(), "order");
  cp.channels.delete("nb");

  // Inbound: what another peer sealed with the same token opens here.
  const fromOther = await seal(key, "cp-other", { kind: "chat", text: "hello back" });
  deliver({ type: "data", roomId: wire, from: "cp-other", payload: fromOther });
  await settle();
  check("a relayed frame sealed under the room key is delivered to onMessage with its true sender",
        got.length === 1 && got[0].from === "cp-other" && got[0].d.text === "hello back", JSON.stringify(got));
  got.length = 0;
  // A relay that re-labels a frame's sender produces nothing.
  deliver({ type: "data", roomId: wire, from: "cp-imposter", payload: fromOther });
  await settle();
  check("a frame whose sender label was changed in transit does not open — the relay cannot re-attribute",
        got.length === 0, JSON.stringify(got));
  // Another room's key produces nothing.
  const otherKey = await deriveRoomKey("cap:room:1111");
  deliver({ type: "data", roomId: wire, from: "cp-other", payload: await seal(otherKey, "cp-other", { kind: "chat", text: "x" }) });
  await settle();
  check("a frame from another room's key does not open", got.length === 0, JSON.stringify(got));

  // Presence and the handshake come from the server, not from WebRTC.
  ready.length = 0;
  deliver({ type: "peers", peers: ["cp-a", "cp-b"], resumed: false });
  check("a fresh join fires onPeerReady for everyone present (the handshake goes to each)",
        ready.length === 2 && ready.includes("cp-a") && ready.includes("cp-b"), JSON.stringify(ready));
  ready.length = 0;
  deliver({ type: "peers", peers: ["cp-a", "cp-b"], resumed: true });
  check("a resume fires onPeerReady for nobody — nothing was lost, nothing is re-served",
        ready.length === 0, JSON.stringify(ready));
  deliver({ type: "joined", peerId: "cp-c" });
  check("a newcomer fires onPeerReady", ready.length === 1 && ready[0] === "cp-c", JSON.stringify(ready));
  check("everyone the server lists is reachable, direct channel or not",
        cp.isReachable("cp-a") && cp.isReachable("cp-c") && !cp.hasChannel("cp-a"), "reachability");

  // A WebRTC link dying is not a departure.
  gone.length = 0;
  const dc = { readyState: "open", send() {}, close() {} };
  cp.setupDataChannel("cp-a", dc);
  dc.onopen();
  dc.onclose();
  check("a data channel closing to a peer the server still lists does not report them gone",
        gone.length === 0 && cp.isReachable("cp-a"), JSON.stringify(gone));
  deliver({ type: "left", peerId: "cp-a" });
  check("the server's left is what reports a departure", gone.length === 1 && gone[0] === "cp-a", JSON.stringify(gone));

  // The socket dies mid-sentence: what is typed is queued and lands on the
  // resume, after the join, in order.
  mark = sent.length;
  sock.readyState = 3;
  sock.onclose?.();
  cp.broadcast({ kind: "chat", text: "typed while down" });
  cp.broadcast({ kind: "chat", text: "and this" });
  await settle();
  check("nothing is sent on a dead socket", since().filter((m) => m.type === "data").length === 0, JSON.stringify(since()));
  cp.wake();                       // the tab came back: reconnect now
  await settle();
  FakeWS.last.onopen?.();
  await tick();
  const after = since();
  const order = after.map((m) => m.type);
  check("on reconnect the join goes first, then the queued frames, in order",
        order[0] === "join" && order[1] === "data" && order[2] === "data" && after[1].from === "cp-me",
        JSON.stringify(order));
  const q1 = await (async () => { const { open } = await import("../src/room-crypto.js"); return open(key, "cp-me", after[1].payload); })();
  check("the queued frames are the ones typed while down", q1?.text === "typed while down", JSON.stringify(q1));

  mark = sent.length;
  cp.leave();
  check("leave() tells the server at once, under the hashed room id",
        since().length === 1 && since()[0].type === "leave" && since()[0].roomId === wire && since()[0].peerId === "cp-me",
        JSON.stringify(since()));
  cp.disconnect();
}

// --- a phone that switched apps: the socket says open and is a corpse ------
// The OS drops the TCP under a frozen tab; on return the WebSocket still
// reads OPEN for minutes. readyState is a claim; the join's reply is proof.
{
  const { deriveRoomKey, open } = await import("../src/room-crypto.js");
  const key = await deriveRoomKey("cap:room:0246");
  const settle = () => new Promise((r) => setTimeout(r, 30));
  QOSPeer.WAKE_PROBE_MS = 60;
  const closes = [];
  const z = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "zz-me",
    onSignalingClose: () => closes.push(1) });
  await z.connect();
  FakeWS.last.onopen?.();
  await tick();
  const corpse = FakeWS.last;
  let mark = sent.length;
  const since = () => sent.slice(mark);

  // Back in the foreground. The socket claims OPEN; nothing answers.
  z.wake();
  z.broadcast({ kind: "chat", text: "typed on return" });
  await settle();
  check("waking sends a join on the socket that claims to be open",
        since().some((m) => m.type === "join"), JSON.stringify(since()));
  check("what is typed before the socket proves itself waits, rather than going into the void",
        since().filter((m) => m.type === "data").length === 0, JSON.stringify(since()));
  await new Promise((r) => setTimeout(r, 120));   // past WAKE_PROBE_MS, no reply
  check("a socket that does not answer the join is declared dead and replaced",
        FakeWS.last !== corpse && corpse.readyState === 3 && closes.length === 1,
        `same socket: ${FakeWS.last === corpse}, closes: ${closes.length}`);
  mark = sent.length;
  FakeWS.last.onopen?.();
  await tick();
  const after = since();
  check("the new socket joins, then delivers what was typed on return",
        after[0]?.type === "join" && after[1]?.type === "data"
        && (await open(key, "zz-me", after[1].payload))?.text === "typed on return",
        JSON.stringify(after.map((m) => m.type)));

  // The other case: the socket answers. Nothing is torn down.
  const live = FakeWS.last;
  mark = sent.length;
  z.wake();
  z.broadcast({ kind: "chat", text: "held briefly" });
  await settle();
  live.onmessage?.({ data: JSON.stringify({ type: "peers", peers: [], resumed: true }) });
  await settle();
  check("a socket that answers is kept, and the held line goes out at once",
        FakeWS.last === live && since().some((m) => m.type === "data") && closes.length === 1,
        JSON.stringify(since().map((m) => m.type)));
  await new Promise((r) => setTimeout(r, 120));
  check("...and the probe does not fire after the answer", FakeWS.last === live && closes.length === 1, "reconnected anyway");
  z.disconnect();
}

// --- which "unknown message type" it is --------------------------------------
// A server from before the pong rejects our ping: chat is fine, and the error
// reply is itself the heartbeat. A server from before the relay rejects the
// data frame: chat is not fine, and it should be said once.
{
  const errs = [];
  const u = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "u-me",
    onSignalingError: (m) => errs.push(m) });
  await u.connect();
  FakeWS.last.onopen?.();
  await tick();
  const w = FakeWS.last;
  const err = (message) => w.onmessage?.({ data: JSON.stringify({ type: "error", message }) });
  err("unknown message type: ping");
  check("a named rejected ping is not a mismatch", errs.length === 0, JSON.stringify(errs));
  u.signal({ type: "ping", t: 1 });
  err("unknown message type");
  check("an unnamed rejection right after a ping is not a mismatch either", errs.length === 0, JSON.stringify(errs));
  err("unknown message type: data");
  err("unknown message type: data");
  check("a rejected data frame is named as an older server, once",
        errs.length === 1 && /older build/.test(errs[0]), JSON.stringify(errs));
  u.disconnect();
}

check("a peer that left is not dialled", offersTo("aaaa") === goneAt, `${offersTo("aaaa")} vs ${goneAt}`);

Date.now = realNow;
console.log(failed === 0 ? "\npeer: all passed" : `\npeer: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
