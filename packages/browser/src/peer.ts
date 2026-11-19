import { generateCapability, validateCapability } from "./zfa.js";
import { roomIdFor, deriveRoomKey, seal, open } from "./room-crypto.js";

// The shape of the room's transport (the Jitsi-shaped rebuild, 2026-09):
//
//   control plane  — every envelope that is not media or bulk (chat, name,
//                    lemmas, notes, polls, gov, every sync-*) rides the
//                    signaling WebSocket as a `data` frame, sealed under a key
//                    derived from the room token (room-crypto.js). One
//                    connection per person, to a host with a public address,
//                    over TLS/443 — the one path that crosses every NAT, CGNAT
//                    and a phone switching apps. The server relays what it
//                    cannot read and is told only a hash of the token.
//   membership     — the server's roster, held across a socket blip by its
//                    grace window (a rejoin under the same peerId is a silent
//                    resume). A WebRTC connection dying is NOT a departure.
//   WebRTC         — calls (media cannot be relayed this way) and bulk
//                    (attachments, /file get: 64 KB frames through a shared
//                    relay is not how 60 MB moves). Dialled opportunistically,
//                    retried patiently, and nothing the room depends on.
//
// Before this every envelope rode the WebRTC mesh, so N−1 NAT-crossing
// connections had to hold for chat to work, and every socket blip became a
// `left`/`joined` and a redial storm for the whole room.

type SignalMsg =
  | { type: "peers";   roomId: string; peers: string[]; resumed?: boolean }
  | { type: "joined";  roomId: string; peerId: string }
  | { type: "left";    roomId: string; peerId: string }
  | { type: "offer";   roomId: string; from: string; to: string; sdp: string }
  | { type: "answer";  roomId: string; from: string; to: string; sdp: string }
  | { type: "ice";     roomId: string; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "data";    roomId: string; from: string; to?: string; payload: string }
  | { type: "pong";    t?: number }
  | { type: "error";   message: string };

/** Options on send()/broadcast(). */
export interface SendOptions {
  /**
   * Bulk goes over a direct WebRTC data channel, never the relay: an
   * attachment or a library fetch is megabytes, and the server's 64 KB frame
   * cap and shared bandwidth are for handshakes and chat. A bulk broadcast
   * floods the WebRTC overlay as before; a bulk send needs an open channel
   * and returns false without one (the caller checks hasChannel first).
   */
  bulk?: boolean;
}

export interface PeerConfig {
  signalingUrl: string;    // ws://localhost:4444
  roomId: string;          // ZFA capability token identifying the room
  iceServers?: RTCIceServer[];
  /** Override the leased identity. Tests use it; the app never does. */
  peerId?: string;
  onSignalingOpen?: () => void;                       // fires on every successful WS connect
  /**
   * This peer can now be sent to — fires once per (their session × our
   * session): for each peer in the room when we join fresh, and for each
   * peer that joins after us. NOT on a silent resume (ours or theirs): nobody
   * lost anything, so there is nothing to re-send. This is where the app does
   * its handshake (name, sync-*) — it used to hang off onChannelOpen, which
   * meant a peer with no direct WebRTC path never got one.
   */
  onPeerReady?: (peerId: string) => void;
  onSignalingClose?: () => void;                      // fires when WS drops (before retry)
  onSignalingError?: (message: string) => void;       // the server refused something
  onMessage?: (from: string, data: unknown) => void;
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelOpen?: (peerId: string) => void;
  onRemoteTrack?: (peerId: string, stream: MediaStream) => void;   // live-call media
  /**
   * A `posix-net` socket channel (see posix-net.ts) opened with this peer.
   * Separate from `onChannelOpen`/`onMessage`, which are the chat/relay "qos"
   * channel — socket traffic never goes through the flood relay, so it gets
   * its own pair of dedicated channels and its own callbacks.
   */
  onSocketChannelOpen?: (peerId: string, kind: SocketChannelKind) => void;
  onSocketMessage?: (peerId: string, kind: SocketChannelKind, data: string) => void;
}

/**
 * The two socket-channel transports posix-net.ts builds TCP-like/UDP-like
 * sockets on top of — see createPeerConnection/initiateConnection/handleOffer.
 * "stream" is ordered+reliable (SCTP default); "dgram" is unordered with no
 * retransmits. Distinct from the chat "qos" channel so socket framing never
 * mixes with, or rides the flood relay of, ordinary chat/state messages.
 */
export type SocketChannelKind = "stream" | "dgram";

/**
 * STUN alone — this file's own fallback when nobody hands it `iceServers`.
 *
 * STUN only tells each side what its public address looks like; the connection
 * is still made directly. Two peers behind symmetric NAT — a corporate network,
 * a mobile carrier doing CGNAT, a NAT'd container — have no address pair that
 * works, so the handshake fails permanently and retrying cannot help. That
 * case needs a TURN relay, and **chat surviving over the flood overlay used to
 * hide this**: a data-channel message can flood peer-to-agent-to-peer with no
 * direct link, but a `MediaStreamTrack` cannot, so a call between two networks
 * produced no video at all, silently (quantum-os#126).
 *
 * `peer.ts` itself still defaults to STUN-only — this constant is what a bare
 * `new QOSPeer(...)` gets (tests, `qospeer.mjs`, anyone who doesn't ask for
 * more). The **app** (`app.ts` `fetchAutoTurn`) is what supplies a relay by
 * default for a real room: it fetches a short-lived, Cloudflare-minted TURN
 * credential from the signaling server's own `GET /turn` (the master API
 * token never leaves that server) and merges it into `iceServers` before
 * `connect()`. "Whose machine your media passes through is a decision" still
 * holds — `/ice auto off` opts out, `/ice turn ...` substitutes your own.
 */
export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// The ICE username fragment identifies an ICE session; a peer that reconnects (or
// reloads its browser, keeping its peerId) dials in with a new one. Used to tell a
// genuine same-session renegotiation from a reconnect under the same peerId. Null
// if the sdp has none.
function iceUfrag(sdp: string | null | undefined): string | null {
  const m = /a=ice-ufrag:(\S+)/.exec(sdp ?? "");
  return m ? m[1] : null;
}

function iceCandidateUfrag(candidate: RTCIceCandidateInit): string | null {
  if (typeof candidate.usernameFragment === "string" && candidate.usernameFragment) {
    return candidate.usernameFragment;
  }
  const m = /\bufrag\s+(\S+)/.exec(candidate.candidate ?? "");
  return m ? m[1] : null;
}

const MAX_PENDING_ICE_PER_PEER = 128;

/**
 * Ring + skip-link neighbor computation for the bounded-degree connection
 * overlay: sort everyone present lexicographically and connect to the peers
 * one and two positions away in each direction (degree 4). A pure function
 * of the roster, so every peer computes the same neighbor sets independently
 * — no coordination message needed — and the relation is symmetric by
 * construction (if B is in A's neighbor set, A is in B's).
 *
 * This degenerates to full mesh automatically for five or fewer peers: at
 * that size every peer is within distance 2 of every other, which is
 * exactly today's behaviour. There is no separate "mesh vs overlay" mode to
 * maintain — one formula. Past five it caps degree at 4 regardless of room
 * size, which is what keeps a big room from exceeding what a browser (or
 * the signaling server's handshake rate limit) will actually sustain.
 */
export function ringSkipNeighbors(sortedIds: string[], myId: string): Set<string> {
  const n = sortedIds.length;
  const i = sortedIds.indexOf(myId);
  const out = new Set<string>();
  if (i === -1 || n <= 1) return out;
  for (const off of [1, -1, 2, -2]) {
    const j = ((i + off) % n + n) % n;
    if (j !== i) out.add(sortedIds[j]);
  }
  return out;
}

/** Key holding "a tab is currently using this id", refreshed while it lives. */
const LEASE = "qos-peer-lease:";
const LEASE_TICK_MS = 5_000;
/** How long without a refresh before an id counts as abandoned. */
const LEASE_STALE_MS = 20_000;

/**
 * An identity that survives a phone discarding the tab.
 *
 * It used to live in sessionStorage alone, which is per-tab and therefore
 * distinct between two tabs — right — but which a mobile browser throws away
 * when it evicts a backgrounded tab. So a phone whose screen locked came back
 * as a NEW peer every time: the room filled with ghosts of its previous
 * incarnations, each listed and unreachable, each intro'd to again, until the
 * signaling heartbeat eventually evicted them. Every symptom of that looks like
 * a connection problem and none of it is one.
 *
 * So an id is leased. A live tab keeps saying it is using its id; a tab that
 * goes away stops, and the next load reclaims the abandoned id rather than
 * minting another. Two tabs open at once still differ, because both leases are
 * fresh and only an expired one can be taken.
 */
/** This browser's dyncap anchor, read straight from the persisted state
 *  (`qos-dyncap-state`, written by app.ts) so peer.ts needn't import dyncap.ts.
 *  Null before the identity exists (very first launch) or if storage is off. */
function myAnchor(): string | null {
  try {
    const raw = localStorage.getItem("qos-dyncap-state");
    if (!raw) return null;
    const a = (JSON.parse(raw) as { anchor?: unknown }).anchor;
    return typeof a === "string" && a.length === 64 ? a : null;
  } catch { return null; }
}

/** A lease records WHO holds the id, not just when it was last seen: a bare
 *  timestamp is legacy (pre-anchor-scoping) and read as anchorless. */
function readLease(raw: string | null): { at: number; anchor: string | null } {
  if (!raw) return { at: 0, anchor: null };
  try {
    const o = JSON.parse(raw) as { at?: unknown; anchor?: unknown };
    if (o && typeof o.at === "number") return { at: o.at, anchor: typeof o.anchor === "string" ? o.anchor : null };
  } catch { /* legacy bare number */ }
  return { at: Number(raw) || 0, anchor: null };
}

function claimPeerId(): string {
  try {
    const mine = sessionStorage.getItem("qos-peer-id");
    if (mine && validateCapability(mine)) { touchLease(mine); return mine; }
  } catch { /* storage unavailable */ }

  // Reclaim an abandoned id rather than mint a new one — BUT only one this same
  // identity held. A lease scoped to a different dyncap anchor belongs to a
  // prior occupant of a recycled id (an identity recovery, a storage clear, an
  // incognito session that leaked a key): taking it means every peer that
  // TOFU-pinned that id refuses our signed `name`/`lemma`/… as an anchor
  // mismatch, and we show up as a permanent hex id. Mint fresh in that case.
  const anchor = myAnchor();
  let reclaimed: string | null = null;
  try {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LEASE)) continue;
      const id = key.slice(LEASE.length);
      if (!validateCapability(id)) continue;
      const lease = readLease(localStorage.getItem(key));
      if (now - lease.at <= LEASE_STALE_MS) continue;                 // still held
      if (lease.anchor && anchor && lease.anchor !== anchor) continue; // a different identity's id
      reclaimed = id; break;
    }
  } catch { /* ignore */ }

  const id = reclaimed ?? generateCapability("peer");
  try { sessionStorage.setItem("qos-peer-id", id); } catch { /* ignore */ }
  touchLease(id);
  return id;
}

function touchLease(id: string): void {
  try { localStorage.setItem(LEASE + id, JSON.stringify({ at: Date.now(), anchor: myAnchor() })); } catch { /* ignore */ }
}

/// A QuantumOS browser peer.
/// Identity is a ZFA capability token — possessing the peer ID IS authorization.
export class QOSPeer {
  readonly peerId: string;
  private ws: WebSocket | null = null;
  private connections = new Map<string, RTCPeerConnection>();
  /**
   * Who the server says is in the room. Kept because being in the room and
   * having a connection are different facts, and the gap between them is what
   * has to be retried.
   */
  private roster = new Set<string>();
  /** peerId → when to try dialling again, and how many times we have. */
  private retryAt = new Map<string, number>();
  private retryN = new Map<string, number>();
  /** peerId → when the current connection attempt began. */
  private attemptAt = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private channels = new Map<string, RTCDataChannel>();
  // posix-net.ts socket channels — see SocketChannelKind above. Kept separate
  // from `channels` (the chat "qos" channel) so socket traffic and its
  // point-to-point-only delivery can never be confused with, or accidentally
  // routed through, the chat flood relay.
  private streamChannels = new Map<string, RTCDataChannel>();
  private dgramChannels = new Map<string, RTCDataChannel>();
  private config: PeerConfig;
  /** What the server is told the room is called — a hash of the token. */
  private wireRoomId = "";
  /** The room key (AES-GCM under HKDF of the token); null until connect() derives it. */
  private roomKey: CryptoKey | null = null;
  /** Serialises sealing so envelopes leave in the order they were sent (a name before its sync). */
  private sealChain: Promise<void> = Promise.resolve();
  /** Serialises opening so envelopes arrive in the order they were relayed. */
  private openChain: Promise<void> = Promise.resolve();
  /**
   * Frames sealed while the socket was down, sent the moment it is back. The
   * client half of the server's grace: a line typed during a blip still lands.
   * Bounded — oldest dropped — because a socket that never comes back must
   * not grow memory forever.
   */
  private outbox: string[] = [];
  private static readonly OUTBOX_MAX = 256;
  private warnedOldServer = false;
  /** The type of the last frame sent — what an unnamed "unknown message type" is about. */
  private lastSentType = "";
  /**
   * Liveness of the socket, decided by traffic rather than by readyState.
   *
   * A phone that switches apps has its TCP connection dropped by the OS while
   * the tab is frozen, and when the tab comes back the WebSocket still says
   * OPEN — for minutes, until the TCP stack gives up. Everything sent goes
   * into that void, the server's own ping/pong never reaches the page (a
   * browser answers pings invisibly and cannot send one), and nothing
   * reconnects. So the socket is trusted only while it is heard from:
   * `lastInboundAt` is any frame at all, an app-level `ping` is sent when it
   * has been quiet, and silence past a limit means the socket is dead
   * whatever it claims. On wake() the socket is *suspect* until the join's
   * own `peers` reply proves it — and while suspect, what is typed waits in
   * the outbox rather than being sent into a socket that may be a corpse.
   */
  private lastInboundAt = 0;
  private suspect = false;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** How long a woken socket has to answer the join before it is declared dead. */
  static WAKE_PROBE_MS = 4_000;
  /** Ping when nothing has been heard for this long… */
  private static readonly QUIET_MS = 25_000;
  /** …and give up on the socket when nothing has been heard for this long. */
  private static readonly SILENT_MS = 70_000;
  private static readonly LIVENESS_TICK_MS = 10_000;
  /**
   * The server cuts a socket that sends a frame over its cap (256 KB,
   * `SIGNAL_MAX_PAYLOAD`), and a cut socket loses everything queued behind
   * the frame. Refuse the one frame instead, loudly.
   */
  private static readonly FRAME_MAX = 250 * 1024;
  private _disconnected = false;   // true after explicit disconnect()
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Peers that are data-only (AI agents): never push call media to them. They have no
  // speaker/headset, can echo our audio back through their WebRTC stack, and the call
  // renegotiation needlessly churns their connection. Populated by the app from its
  // agent map.
  readonly dataOnly = new Set<string>();
  // Reconnect backoff: doubles on each failed attempt up to a cap, with ±50% jitter
  // (so concurrent peers/tabs desync instead of retrying in lock-step). The free
  // signaling server rate-limits; a fixed/instant retry makes a dropped tab re-hammer
  // it → "rate limit exceeded" → drop → storm. CRUCIAL: the backoff only RESETS to the
  // floor after a connection stays up ≥ STABLE_MS — a rate-limited open-then-instant-
  // close must keep backing off, not reset to the floor every cycle and re-storm (the
  // old bug: resetting on `open` alone).
  private _reconnectDelay = 1500;
  private static readonly RECONNECT_MIN = 1500;
  private static readonly RECONNECT_MAX = 30000;
  /// Gap between offers when dialling a room's existing peers (see "peers" below).
  private static readonly JOIN_STAGGER_MS = 250;
  /**
   * How many handshakes may be in flight at once.
   *
   * A dial is not one message: it is an offer and then a trickle of ICE
   * candidates, and doing that to everybody at once makes a join cost a burst
   * that grows with the room. Past what the signaling server will carry per
   * connection, handshakes stop completing — which from inside a browser looks
   * exactly like peers who never arrived. Three at a time finishes a room of
   * ten in a few seconds and never spikes.
   */
  private static readonly MAX_IN_FLIGHT = 3;
  /// How often to look for peers in the room we have no channel to.
  private static readonly SWEEP_MS = 12_000;
  /// Backoff between attempts at one peer, doubling to a ceiling.
  /// Long enough for a slow path to finish: mobile networks gather more
  /// candidates and check them for longer than a laptop on wifi does.
  private static readonly RETRY_MIN_MS = 20_000;
  /// How long a connection may be "connecting" before it counts as stuck.
  private static readonly ATTEMPT_PATIENCE_MS = 45_000;
  /// How much longer the higher-id side waits, so the two rarely dial at once.
  private static readonly POLITE_EXTRA_MS = 7_000;
  private static readonly RETRY_MAX_MS = 90_000;
  private static readonly STABLE_MS = 15000;   // a connection must survive this long to reset the backoff
  // Live-call media: the local mic/cam stream shared into all connections, and a
  // per-peer "we have an outstanding offer" flag for perfect-negotiation glare.
  private localStream: MediaStream | null = null;
  private makingOffer = new Map<string, boolean>();
  // Candidates can arrive before the offer creates a PC, or while its remote
  // description is still being installed. Keep a bounded per-peer queue.
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  // Per-peer grace timer for a transient ICE "disconnected": WebRTC can briefly
  // flap to "disconnected" and recover to "connected". We only declare the peer
  // gone if it has not recovered within this window — preventing a ghost from
  // lingering (handled) AND a healthy peer from being evicted on a blip.
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DISCONNECT_GRACE_MS = 8000;

  // Bounded-degree overlay (ring + skip-links, see ringSkipNeighbors above).
  // `pins` are peers we want a direct link to regardless of ring position
  // (an agent, a diagnostic /conn "connect now", a future call participant)
  // — additive on top of the computed neighbor set.
  private pins = new Set<string>();
  // Grace-then-close timers for open connections that fell outside the
  // target neighbor set (roster reshuffle, or an unpin). Mirrors
  // disconnectTimers' shape, but a prune is not a departure — see prunePeer.
  private pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Between DISCONNECT_GRACE_MS (8s, a real ICE blip) and RETRY_MAX_MS (90s,
  // a failing dial's backoff ceiling) — enough for a couple of SWEEP_MS
  // cycles to let a roster reshuffle (peers joining/leaving close together)
  // settle before actually closing a link that's still working.
  private static readonly PRUNE_GRACE_MS = 30_000;

  // Message relay (flooding, no routing table) for reaching a peer beyond
  // direct reach — see broadcast()/send()/handleRelay(). `seenRelay` dedupes
  // a message that reaches us by two paths (a ring link and its skip-link);
  // bounded like bridge.mjs's own durable dedupe (firstState), since this
  // must survive the message's full multi-hop lifetime, not just one burst.
  private seenRelay = new Set<string>();
  private static readonly SEEN_RELAY_MAX = 5000;
  private relayCounter = 0;
  // A per-instance nonce mixed into every relay id. `${peerId}:${counter}` is
  // NOT unique across reloads — `relayCounter` restarts at 0 in a fresh page
  // context, reusing ids that other peers (whose page did not reload) still
  // hold in `seenRelay`, so a reloaded peer's first messages are silently
  // deduped away. A mobile tab reloads constantly (sleep, eviction). The nonce
  // makes each session's ids disjoint.
  private readonly relaySession = Math.random().toString(36).slice(2, 10);

  // When a peer was last heard from over a bulk relay hop (its _from tag) —
  // a secondary reachability signal; the primary one is the server's roster.
  private lastHeardVia = new Map<string, number>();
  private static readonly REACHABLE_WINDOW_MS = 45_000;

  constructor(config: PeerConfig) {
    this.config = config;
    this.peerId = config.peerId ?? claimPeerId();
    // Keep saying this id is live, so a tab that goes away stops saying it and
    // the next one can take it back.
    try {
      this.leaseTimer = setInterval(() => touchLease(this.peerId), LEASE_TICK_MS);
    } catch { /* no storage, no lease */ }
  }

  /**
   * Join the room. Resolves once the room key is derived and the first
   * socket is on its way (not once it is open — that is onSignalingOpen).
   * Throws only if WebCrypto is unavailable, in which case nothing could be
   * sealed and joining would put the room's traffic in the clear.
   */
  async connect(): Promise<void> {
    this._disconnected = false;
    if (!validateCapability(this.config.roomId)) {
      console.warn(`[qos-peer] roomId ZFA check failed (may be cached token): ${this.config.roomId}`);
    }
    if (!this.roomKey) {
      this.wireRoomId = await roomIdFor(this.config.roomId);
      this.roomKey = await deriveRoomKey(this.config.roomId);
    }
    if (this._disconnected) return;   // disconnect() raced the derivation
    this._openSignaling().catch(() => this._scheduleReconnect());
    // A peer in the room we have no direct link to is one calls and bulk
    // cannot reach. Look for those on a timer rather than only when the
    // server happens to re-send the room's list.
    if (!this.sweepTimer) this.sweepTimer = setInterval(() => this.sweep(), QOSPeer.SWEEP_MS);
  }

  disconnect(): void {
    this._disconnected = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._stableTimer) clearTimeout(this._stableTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.outbox = [];
    // An explicit leave is immediate on the server; only a socket that
    // *vanishes* is grace-held. Closing the tab must not hold a seat.
    this.signal({ type: "leave", roomId: this.wireRoomId, peerId: this.peerId });
    for (const pc of this.connections.values()) pc.close();
    this.ws?.close();
    this.connections.clear();
    this.channels.clear();
    this.streamChannels.clear();
    this.dgramChannels.clear();
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
    for (const t of this.pruneTimers.values()) clearTimeout(t);
    this.pruneTimers.clear();
  }

  /// Tell the server we are leaving, and nothing else — for pagehide, where
  /// the page is going away and the socket is about to die anyway. Without
  /// this the server would hold the seat for its grace window, and the room
  /// would see a departed person as present for a minute.
  leave(): void {
    this.signal({ type: "leave", roomId: this.wireRoomId, peerId: this.peerId });
  }

  /// Recover promptly after a background-throttled / frozen tab returns to the
  /// foreground. Browsers throttle hidden tabs (starving WebRTC consent-freshness)
  /// and clamp our reconnect setTimeout, so peers drop and come back only slowly.
  /// Called from a visibilitychange/focus handler: if signaling is dead, reconnect
  /// NOW (cancel the throttled backoff and reset it); if it's alive, re-join so the
  /// server re-sends the peer list and we re-establish any channels that lapsed.
  wake(): void {
    if (this._disconnected) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      this._reconnectDelay = QOSPeer.RECONNECT_MIN;        // reset backoff — we're foreground again
      void this._reconnectSignaling();
    } else if (ws.readyState === WebSocket.OPEN) {
      // A re-join on a live socket is a resume on the server: silent to the
      // room, and it re-sends the roster so anything we missed is refreshed.
      // It is also the probe: OPEN is a claim, the `peers` reply is proof.
      // Until it arrives the socket is suspect and outbound waits (see
      // queueSealed); if it never arrives, the socket is a corpse — close it
      // and reconnect now, at which point the outbox is flushed after the
      // fresh join (a resume, if inside the server's grace).
      this.suspect = true;
      this.signal({ type: "join", roomId: this.wireRoomId, peerId: this.peerId });
      if (this.probeTimer) clearTimeout(this.probeTimer);
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null;
        if (!this.suspect || this.ws !== ws) return;
        console.warn("[qos-peer] woke to a socket that says open but does not answer — reconnecting");
        this.declareSocketDead(ws);
      }, QOSPeer.WAKE_PROBE_MS);
    }
  }

  /// A socket that has stopped answering. Closing it fires onclose, which
  /// schedules the reconnect; the backoff is reset because this is a
  /// detected death, not a refused connect.
  private declareSocketDead(ws: WebSocket): void {
    this.suspect = false;
    this._reconnectDelay = QOSPeer.RECONNECT_MIN;
    try { ws.close(); } catch { /* ignore */ }
    // Some browsers only fire onclose once the close handshake completes,
    // which on a dead TCP connection is never. Detach and reconnect ourselves.
    if (this.ws === ws) {
      ws.onclose = null;
      this.ws = null;
      if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
      this.config.onSignalingClose?.();
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      void this._reconnectSignaling();
    }
  }

  /// Any frame at all proves the socket. Clears a wake-time suspicion and
  /// releases what was waiting on it.
  private heard(): void {
    this.lastInboundAt = Date.now();
    if (!this.suspect) return;
    this.suspect = false;
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
    this.flushOutbox();
  }

  private flushOutbox(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const pending = this.outbox; this.outbox = [];
    if (pending.length) this.lastSentType = "data";
    for (const text of pending) ws.send(text);
  }

  /**
   * Make sure we are at least trying to reach this peer.
   *
   * The room's roster and this one can disagree: a `peers` list replaces this
   * set wholesale, so a peer the server omitted once — mid-flap, or joining as
   * the list was built — is dropped here while the app still shows them
   * present. Nothing then dials them, and the room reports somebody present
   * that no attempt is being made to reach, which is as useless as it sounds.
   * The app can say "this one, now".
   */
  ensureConnected(peerId: string): void {
    if (this._disconnected || peerId === this.peerId) return;
    this.roster.add(peerId);
    this.pinNeighbor(peerId);
  }

  /**
   * Always keep a direct link to this peer, regardless of ring/skip
   * position — additive on top of the computed overlay neighbor set (see
   * ringSkipNeighbors). Used for peers we deliberately want reachable no
   * matter how the room is shaped: an AI agent, a diagnostic "connect now",
   * a live-call participant (media can't be relayed).
   *
   * Pinning is a local, one-sided decision — the other side has no wire
   * signal that we just pinned them — so it dials immediately rather than
   * waiting for the next sweep/reconcile pass, the same way ensureConnected
   * always has.
   */
  pinNeighbor(peerId: string): void {
    if (peerId === this.peerId) return;
    this.pins.add(peerId);
    if (this.channels.get(peerId)?.readyState === "open") return;
    if (this.connecting(peerId)) return;
    this.retryAt.delete(peerId);
    void this.initiateConnection(peerId);
  }

  /// Release a pin. The link doesn't close instantly — it goes through the
  /// same grace-then-prune path as any other connection that's fallen
  /// outside the target set, in case it's still a ring/skip neighbor anyway.
  unpinNeighbor(peerId: string): void {
    this.pins.delete(peerId);
    this.reconcilePrune();
  }

  /// Who we should be directly connected to right now: ring+skip neighbors
  /// (see ringSkipNeighbors) plus anything pinned. Full mesh falls out of
  /// this automatically for five or fewer peers.
  private targetPeers(): Set<string> {
    const sorted = [...new Set([...this.roster, this.peerId])].sort();
    const set = ringSkipNeighbors(sorted, this.peerId);
    for (const p of this.pins) if (p !== this.peerId) set.add(p);
    return set;
  }

  /// Can we reach this peer at all? Under the relayed control plane that is
  /// the server's word: a peer in the roster gets what we send (queued for
  /// them through a blip), whether or not a direct WebRTC link exists. A
  /// direct channel, or recent bulk-relay traffic, also counts. hasChannel
  /// answers the narrower "am I directly linked to them", which is what a
  /// call or a file transfer needs and what /conn diagnoses.
  isReachable(peerId: string): boolean {
    if (this.roster.has(peerId)) return true;
    if (this.hasChannel(peerId)) return true;
    const last = this.lastHeardVia.get(peerId);
    return last !== undefined && Date.now() - last < QOSPeer.REACHABLE_WINDOW_MS;
  }

  /**
   * What every connection is doing right now.
   *
   * The roster can say reachable or not; this says why not. "checking" that
   * never ends is candidates that never pair; "failed" is no path at all; a
   * connection that is "connected" with no open channel is a different fault
   * again. Guessing between those has cost a whole evening.
   */
  connectionReport(): { peerId: string; channel: string; connection: string; ice: string }[] {
    const ids = new Set([...this.roster, ...this.connections.keys(), ...this.channels.keys()]);
    ids.delete(this.peerId);
    return [...ids].map((peerId) => ({
      peerId,
      channel: this.channels.get(peerId)?.readyState ?? "none",
      connection: this.connections.get(peerId)?.connectionState ?? "none",
      ice: this.connections.get(peerId)?.iceConnectionState ?? "none",
    }));
  }

  /// Whether the signaling WebSocket is currently open (used to label connection status).
  isSignalingUp(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  /// Whether a data channel to this peer is open — whether anything we send
  /// them can actually arrive. Being in the room is NOT the same thing: the
  /// signaling server can list a peer whose WebRTC handshake never completed,
  /// and to that peer everything typed here is silence.
  hasChannel(peerId: string): boolean {
    return this.channels.get(peerId)?.readyState === "open";
  }

  /// Is a posix-net socket channel of this kind open to this peer? Unlike
  /// hasChannel/isReachable there is no flood/relay fallback for sockets —
  /// they are point-to-point by definition (see docs/connection.md's
  /// posix-net section) — so this is the only way to reach one, and
  /// posix-net.ts's connect() must pin the peer directly first.
  hasSocketChannel(peerId: string, kind: SocketChannelKind): boolean {
    const map = kind === "stream" ? this.streamChannels : this.dgramChannels;
    return map.get(peerId)?.readyState === "open";
  }

  /// Send a raw posix-net frame to a peer over its dedicated socket channel.
  /// Never flood-relayed — returns false if no direct channel is open, so
  /// posix-net.ts can surface "not connected" rather than silently routing
  /// socket bytes through unrelated peers.
  sendSocketFrame(peerId: string, kind: SocketChannelKind, data: string): boolean {
    const map = kind === "stream" ? this.streamChannels : this.dgramChannels;
    const ch = map.get(peerId);
    if (ch?.readyState !== "open") return false;
    ch.send(data);
    return true;
  }

  private setupSocketChannel(peerId: string, ch: RTCDataChannel, kind: SocketChannelKind): void {
    const map = kind === "stream" ? this.streamChannels : this.dgramChannels;
    ch.onopen = () => {
      map.set(peerId, ch);
      this.config.onSocketChannelOpen?.(peerId, kind);
    };
    ch.onclose = () => { map.delete(peerId); };
    ch.onmessage = (event) => { this.config.onSocketMessage?.(peerId, kind, event.data); };
  }

  /// Send to one peer. The control plane: sealed under the room key and
  /// relayed by the server, which queues it for them through a blip — so
  /// this returns true whenever they are someone we could address (the
  /// frame is queued here too if our own socket is momentarily down).
  /// `bulk` goes over a direct channel only, and is false without one.
  send(targetPeerId: string, data: unknown, opts?: SendOptions): boolean {
    if (opts?.bulk) {
      const ch = this.channels.get(targetPeerId);
      if (!ch || ch.readyState !== "open") return false;
      ch.send(JSON.stringify(data));
      return true;
    }
    if (!this.roomKey) return false;
    this.queueSealed(targetPeerId, data);
    return true;
  }

  /// Broadcast to the room. The control plane: one sealed frame to the
  /// server, which fans it out to everyone present and queues it for anyone
  /// grace-held. `bulk` instead floods the WebRTC overlay (see
  /// ringSkipNeighbors / handleRelay) — tagged with a dedupe id and a hop
  /// budget so a peer beyond direct reach still gets it once.
  broadcast(data: unknown, opts?: SendOptions): void {
    if (opts?.bulk) {
      const relayId = this.nextRelayId();
      const tagged = {
        ...(data as Record<string, unknown>),
        _relayId: relayId, _hops: this.hopBudget(), _from: this.peerId,
      };
      const payload = JSON.stringify(tagged);
      for (const ch of this.channels.values()) {
        if (ch.readyState === "open") ch.send(payload);
      }
      return;
    }
    if (!this.roomKey) return;
    this.queueSealed(undefined, data);
  }

  /// Seal one envelope (in order) and put it on the wire, or in the outbox
  /// if the socket is between lives.
  private queueSealed(to: string | undefined, data: unknown): void {
    const key = this.roomKey!;
    this.sealChain = this.sealChain.then(async () => {
      const payload = await seal(key, this.peerId, data);
      const frame: SignalMsg = { type: "data", roomId: this.wireRoomId, from: this.peerId, payload };
      if (to !== undefined) frame.to = to;
      const text = JSON.stringify(frame);
      if (text.length > QOSPeer.FRAME_MAX) {
        const kind = (data as { kind?: unknown })?.kind;
        console.error(`[qos-peer] not sending a ${String(kind)} frame of ${text.length} bytes — over the relay's cap; bulk goes over WebRTC ({bulk:true})`);
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN && !this.suspect) { this.lastSentType = "data"; this.ws.send(text); return; }
      if (this._disconnected) return;
      this.outbox.push(text);
      if (this.outbox.length > QOSPeer.OUTBOX_MAX) this.outbox.shift();
    }).catch((e) => console.warn("[qos-peer] seal failed", e));
  }

  /// A relayed `data` frame: open it (in order) and deliver. One that does
  /// not open — another room's key, a re-labelled sender, a tampered byte —
  /// is dropped without a word to the app; the relay is not trusted to be
  /// right, only to be there.
  private receiveSealed(msg: Extract<SignalMsg, { type: "data" }>): void {
    const key = this.roomKey;
    if (!key) return;
    this.openChain = this.openChain.then(async () => {
      const obj = await open(key, msg.from, msg.payload);
      if (obj === null) { console.warn(`[qos-peer] dropped a frame from ${msg.from.slice(-8)} that did not open`); return; }
      if (this._disconnected) return;
      this.config.onMessage?.(msg.from, obj);
    }).catch((e) => console.warn("[qos-peer] open failed", e));
  }

  /// Unique id for one flood — `${peerId}:${session}:${counter}`, unique across
  /// peers AND across reloads of the same peer (see relaySession). Marked seen
  /// immediately, not just on receipt: without this, a broadcast that loops all
  /// the way around the ring back to its own originator would be delivered to
  /// onMessage twice.
  private nextRelayId(): string {
    const id = `${this.peerId}:${this.relaySession}:${this.relayCounter++}`;
    this.seenRelay.add(id);
    if (this.seenRelay.size > QOSPeer.SEEN_RELAY_MAX) this.seenRelay.clear();
    return id;
  }

  /// Remaining-hop budget for a new flood — roughly 2x the true worst-case
  /// ring+skip diameter (~n/4), erring generous: dedupe already bounds the
  /// redundant-relay cost of an oversized budget, while an undersized one
  /// would mean a directed send genuinely fails to arrive.
  private hopBudget(): number {
    return Math.max(4, Math.ceil((this.roster.size + 1) / 2));
  }

  /// Largest send-buffer backlog across open channels (bytes) — used to pace
  /// large chunked transfers so we don't overflow the SCTP send buffer.
  maxBufferedAmount(): number {
    let max = 0;
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open" && ch.bufferedAmount > max) max = ch.bufferedAmount;
    }
    return max;
  }

  /// Start sharing a local mic/camera stream into every peer connection (live
  /// call). Adds the tracks and renegotiates each connection.
  addLocalMedia(stream: MediaStream): void {
    this.localStream = stream;
    for (const [peerId, pc] of this.connections) {
      if (this.dataOnly.has(peerId)) continue;   // agents never get call media
      for (const track of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, stream);
      }
      void this.renegotiate(peerId, pc);
    }
  }

  /// The senders carrying our video, one per connection that has one.
  ///
  /// A screen share replaces the track on all of them: one connection per peer,
  /// so swapping only the first would share with one person and leave everyone
  /// else looking at the camera.
  videoSenders(): RTCRtpSender[] {
    const out: RTCRtpSender[] = [];
    for (const [peerId, pc] of this.connections) {
      if (this.dataOnly.has(peerId)) continue;
      for (const s of pc.getSenders()) if (s.track?.kind === "video") out.push(s);
    }
    return out;
  }

  /// Stop sharing local media: remove our senders from every connection and
  /// renegotiate. The remote sees the tracks end.
  removeLocalMedia(): void {
    const stream = this.localStream;
    this.localStream = null;
    if (!stream) return;
    const mine = new Set(stream.getTracks());
    for (const [peerId, pc] of this.connections) {
      for (const sender of pc.getSenders()) {
        if (sender.track && mine.has(sender.track)) {
          try { pc.removeTrack(sender); } catch { /* already gone */ }
        }
      }
      void this.renegotiate(peerId, pc);
    }
  }

  /// Send a fresh offer on an established connection (media (re)negotiation).
  /// Glare is resolved by handleOffer's polite/impolite rule.
  private async renegotiate(peerId: string, pc: RTCPeerConnection): Promise<void> {
    try {
      this.makingOffer.set(peerId, true);
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return;   // a remote offer landed first
      await pc.setLocalDescription(offer);
      this.signal({
        type: "offer", roomId: this.wireRoomId,
        from: this.peerId, to: peerId, sdp: pc.localDescription!.sdp,
      });
    } catch (e) {
      console.warn("[qos-peer] renegotiate failed", e);
    } finally {
      this.makingOffer.set(peerId, false);
    }
  }

  private async _openSignaling(): Promise<void> {
    const ws = new WebSocket(this.config.signalingUrl);
    this.ws = ws;

    // CONNECT-TIMEOUT WATCHDOG. A hung/half-open signaling socket can fire NEITHER
    // `onopen` NOR `onerror`: the server accepts the TCP then never completes the WS
    // handshake (e.g. a free-tier signaling server that died mid-flight). Without a
    // bound this connect promise never settles, so `_openSignaling` hangs forever and
    // the peer wedges — alive but permanently disconnected, never rescheduling a
    // reconnect (the post-open heartbeat cannot help, because `onopen` never fired).
    // Bound the handshake: if `onopen` hasn't arrived within CONNECT_TIMEOUT_MS, close
    // the socket and reject so the caller (`connect`/`_reconnectSignaling`) reschedules
    // with backoff. Self-heals the wedge a hard signaling-server drop used to cause.
    const CONNECT_TIMEOUT_MS = 20000;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("signaling connect timeout"));
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = (e) => { clearTimeout(t); reject(e); };
    });

    // Reset the backoff only once the connection PROVES stable (≥ STABLE_MS). A
    // rate-limited server opens then immediately drops us; resetting on `open` alone
    // would relaunch the storm at the floor delay every cycle.
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) this._reconnectDelay = QOSPeer.RECONNECT_MIN;
    }, QOSPeer.STABLE_MS);

    ws.onmessage = (event) => {
      this.heard();
      try {
        const msg = JSON.parse(event.data) as SignalMsg;
        this.handleSignal(msg);
      } catch {
        console.error("[qos-peer] invalid signal message");
      }
    };

    // Liveness by traffic (see lastInboundAt). A fresh socket starts trusted.
    this.suspect = false;
    this.lastInboundAt = Date.now();
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      const quiet = Date.now() - this.lastInboundAt;
      if (quiet > QOSPeer.SILENT_MS) {
        console.warn(`[qos-peer] nothing heard from signaling for ${Math.round(quiet / 1000)}s — reconnecting`);
        this.declareSocketDead(ws);
      } else if (quiet > QOSPeer.QUIET_MS) {
        this.signal({ type: "ping", t: Date.now() });
      }
    }, QOSPeer.LIVENESS_TICK_MS);

    ws.onclose = () => {
      if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
      if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
      if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
      this.suspect = false;
      if (this._disconnected) return;
      this.config.onSignalingClose?.();
      this._scheduleReconnect();
    };

    // Join the room — a resume, if the server still holds our seat.
    this.signal({ type: "join", roomId: this.wireRoomId, peerId: this.peerId });
    // Then whatever was typed while the socket was down.
    this.flushOutbox();
    this.config.onSignalingOpen?.();
  }

  /// Schedule a reconnect with exponential backoff + ±50% jitter, single-flight.
  /// Grows the delay each call; the stability timer in `_openSignaling` resets it
  /// once a connection has lasted ≥ STABLE_MS.
  private _scheduleReconnect(): void {
    if (this._disconnected || this._reconnectTimer) return;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, QOSPeer.RECONNECT_MAX);
    const delay = Math.round(this._reconnectDelay * (0.5 + Math.random()));
    console.warn(`[qos-peer] signaling disconnected — reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; void this._reconnectSignaling(); }, delay);
  }

  private async _reconnectSignaling(): Promise<void> {
    if (this._disconnected) return;
    try {
      await this._openSignaling();
      console.log("[qos-peer] signaling reconnected");
    } catch {
      this._scheduleReconnect();
    }
  }

  private handleSignal(msg: SignalMsg): void {
    switch (msg.type) {
      case "peers": {
        // On signaling reconnect the server re-sends the peers list. Skip peers
        // where the WebRTC data channel is still open — no need to re-establish.
        //
        // We dial our overlay targets only (see targetPeers/ringSkipNeighbors),
        // not everyone in the room — but onPeerJoined still fires for every
        // peer in the list, unfiltered, so the app's roster keeps showing
        // everyone present, whether or not they're a direct neighbor.
        //
        // The dial is staggered. Firing every offer at once is a burst the
        // joiner inflicts on itself: each connection follows its offer with
        // its own ICE candidates, so N-1 offers plus their candidate storms
        // land in the same instant, tripping the server's per-connection rate
        // limit exactly when a room needs every handshake to land. A join
        // spread over a second or two is not slower in any way a person
        // notices — and bounded degree means N-1 was never really the count
        // anyway, just the four-ish targets below.
        this.roster = new Set(msg.peers);
        const targets = this.targetPeers();
        let nth = 0;
        for (const peerId of msg.peers) {
          this.config.onPeerJoined?.(peerId);
          // Fresh in the room: everyone here needs our handshake. On a
          // resume they already have it — the seat never emptied.
          if (!msg.resumed) this.config.onPeerReady?.(peerId);
          if (!targets.has(peerId)) continue;
          const ch = this.channels.get(peerId);
          if (ch?.readyState === "open") continue;
          const at = nth++ * QOSPeer.JOIN_STAGGER_MS;
          if (at === 0) { void this.initiateConnection(peerId); continue; }
          setTimeout(() => {
            if (this._disconnected) return;
            if (this.channels.get(peerId)?.readyState === "open") return;
            // Wait rather than pile on: the sweep will pick up whoever is left.
            if (this.inFlight() >= QOSPeer.MAX_IN_FLIGHT) return;
            void this.initiateConnection(peerId);
          }, at);
        }
        // A roster arriving fresh (we just (re)connected) is the one moment
        // we're the unilateral initiator — safe to dial immediately above.
        // Pruning is always safe (a local, unilateral decision), so it runs
        // here too.
        this.reconcilePrune();
        break;
      }
      case "joined":
        // The joiner dials us, which is why nothing is initiated here — but a
        // dial that never lands has to be retried by somebody, and the sweep
        // below is what does it. (Both sides now potentially want to dial
        // each other under the new roster — sweep's existing polite/impolite
        // glare handling is what makes that safe; reconcilePrune below only
        // ever closes a link, never opens one, so it can't glare.)
        this.roster.add(msg.peerId);
        this.config.onPeerJoined?.(msg.peerId);
        this.config.onPeerReady?.(msg.peerId);
        this.reconcilePrune();
        break;
      case "left":
        this.roster.delete(msg.peerId);
        this.retryAt.delete(msg.peerId);
        this.retryN.delete(msg.peerId);
        // A genuine departure clears any pin too — otherwise ensureConnected
        // or an agent-tag pin would keep sweep() chasing someone provably
        // gone forever (pins are sticky by design, but "gone" overrides it).
        this.pins.delete(msg.peerId);
        this.cleanup(msg.peerId);
        this.clearPruneTimer(msg.peerId);
        this.config.onPeerLeft?.(msg.peerId);
        this.reconcilePrune();
        break;
      case "offer":
        this.handleOffer(msg.from, msg.sdp);
        break;
      case "answer":
        this.handleAnswer(msg.from, msg.sdp);
        break;
      case "ice":
        this.handleIce(msg.from, msg.candidate);
        break;
      case "data":
        this.receiveSealed(msg);
        break;
      case "pong":
        break;   // heard() already did the work
      case "error":
        // Surfaced, not swallowed. "rate limit exceeded" is the server telling
        // us the room is bigger than the join burst it will carry — the exact
        // failure that looks, from inside a browser, like peers who never
        // arrived. Nobody could see it, so it was argued about instead.
        // "unknown message type" means the server predates something we
        // sent — but which thing matters. A rejected `ping` is a server from
        // before the pong (2026-09-19) and chat is fine: the error reply is
        // itself the heartbeat we wanted, so say nothing. A rejected `data`
        // frame is a server from before the relay (2026-09-18) and every line
        // typed would come back as this — say what it is, once. A newer
        // server names the type; an older one does not, so fall back to what
        // we last sent.
        if (msg.message.startsWith("unknown message type")) {
          const named = msg.message.split(": ")[1];
          const rejected = named ?? this.lastSentType;
          if (rejected === "ping") break;
          if (this.warnedOldServer) break;
          this.warnedOldServer = true;
          this.config.onSignalingError?.("the signaling server is an older build than this page — chat needs the resume/relay build (2026-09-18) deployed there");
          break;
        }
        console.error("[signaling]", msg.message);
        this.config.onSignalingError?.(msg.message);
        break;
    }
  }

  /**
   * Dial the peers we are in a room with and have no channel to.
   *
   * A handshake that fails once used to stay failed: connections are only
   * initiated from the server's peers list, which arrives when *we* join or
   * reconnect. So two people who failed to connect stayed silent to each other
   * indefinitely — until somebody else joined and the list was re-sent, which
   * is a fix arriving by coincidence.
   *
   * Only one side of a pair retries, chosen by comparing ids. Two peers dialling
   * each other at the same moment is glare — each answering an offer while
   * holding one of its own — and the recovery for glare is worse than the
   * failure it would be recovering from.
   */
  private sweep(): void {
    if (this._disconnected || !this.isSignalingUp()) return;
    // Cheap backstop: reconcilePrune is called on every roster/pin change
    // already, but this catches anything a missed event would otherwise
    // leave stuck open past its target window.
    this.reconcilePrune();
    const now = Date.now();
    for (const peerId of this.targetPeers()) {
      if (peerId === this.peerId) continue;
      if (this.channels.get(peerId)?.readyState === "open") continue;
      // An attempt already under way is not a failure to retry. Redialling one
      // sends a fresh offer with a new ICE ufrag, the far side rebuilds, and
      // the negotiation in flight is thrown away — so a peer whose path is
      // simply slow (mobile, more candidates, longer checks) would be reset
      // before it could ever finish, forever.
      if (this.connecting(peerId)) continue;
      if (now < (this.retryAt.get(peerId) ?? 0)) continue;
      if (this.inFlight() >= QOSPeer.MAX_IN_FLIGHT) break;
      const n = (this.retryN.get(peerId) ?? 0) + 1;
      this.retryN.set(peerId, n);
      // Both sides may dial, and the one with the higher id waits a little
      // longer before doing so. Deferring to the other side entirely — the
      // earlier rule — assumed the other side also retries, which is false the
      // moment the room is a mix of builds: nobody dialled and the connection
      // never came back. Waiting instead means the usual case is still one
      // dialler (the other's attempt is in flight, so `connecting()` skips this
      // one), while a peer that will never dial is no longer fatal.
      const polite = this.peerId > peerId ? QOSPeer.POLITE_EXTRA_MS : 0;
      const wait = Math.min(QOSPeer.RETRY_MAX_MS, QOSPeer.RETRY_MIN_MS * 2 ** (n - 1)) + polite;
      // Jitter, so a room that all failed at once does not all retry at once.
      this.retryAt.set(peerId, now + Math.round(wait * (0.75 + Math.random() * 0.5)));
      console.log(`[qos-peer] retrying ${peerId} (attempt ${n})`);
      void this.initiateConnection(peerId);
    }
  }

  /**
   * Is a connection to this peer still being made?
   *
   * "connecting" and "new" mean ICE is still working; a check that has been
   * running for longer than any real handshake takes is treated as stuck, so a
   * negotiation that silently died cannot block retries indefinitely.
   */
  /** Handshakes currently under way, which is what a burst is made of. */
  private inFlight(): number {
    let n = 0;
    for (const peerId of this.connections.keys()) if (this.connecting(peerId)) n++;
    return n;
  }

  private connecting(peerId: string): boolean {
    const pc = this.connections.get(peerId);
    if (!pc) return false;
    const state = pc.connectionState;
    if (state !== "new" && state !== "connecting") return false;
    const since = this.attemptAt.get(peerId) ?? 0;
    return Date.now() - since < QOSPeer.ATTEMPT_PATIENCE_MS;
  }

  private async initiateConnection(remotePeerId: string): Promise<void> {
    // When this attempt began, so the sweep can tell "still working on it" from
    // "died quietly" without asking the connection, which says "connecting"
    // either way.
    this.attemptAt.set(remotePeerId, Date.now());
    const pc = this.createPeerConnection(remotePeerId);

    // A local offer is one half of a negotiation attempt. Mark it before
    // awaiting createOffer/setLocalDescription so an incoming offer that
    // arrives during either await is handled as glare, not as a fresh stable
    // connection. Clear it on every exit so later renegotiations are unaffected.
    this.makingOffer.set(remotePeerId, true);
    try {
      const ch = pc.createDataChannel("qos");
      this.setupDataChannel(remotePeerId, ch);
      // posix-net.ts's two socket transports — created alongside the chat
      // channel so a single offer/answer establishes all three; see
      // SocketChannelKind. Unused until something actually opens a socket to
      // this peer, so the cost of always creating them is negligible.
      this.setupSocketChannel(remotePeerId, pc.createDataChannel("qos-stream"), "stream");
      this.setupSocketChannel(
        remotePeerId,
        pc.createDataChannel("qos-dgram", { ordered: false, maxRetransmits: 0 }),
        "dgram",
      );

      const offer = await pc.createOffer();
      // Read through a function so TypeScript does not incorrectly keep a
      // pre-await narrowing across the next asynchronous WebRTC operation.
      const remoteOfferWon = () => pc.remoteDescription?.type === "offer";
      // A polite peer may have accepted an incoming offer while createOffer()
      // was pending. Its remote description remains an offer after answering;
      // do not overwrite that answer with the now-stale local offer.
      if (remoteOfferWon()) return;
      await pc.setLocalDescription(offer);
      // An incoming offer can also win while setLocalDescription() is pending.
      if (remoteOfferWon() && pc.localDescription?.type === "answer") return;

      this.signal({
        type: "offer",
        roomId: this.wireRoomId,
        from: this.peerId,
        to: remotePeerId,
        sdp: pc.localDescription?.sdp ?? offer.sdp!,
      });
    } catch (e) {
      console.warn("[qos-peer] initiateConnection failed", e);
    } finally {
      this.makingOffer.set(remotePeerId, false);
    }
  }

  private async handleOffer(fromPeerId: string, sdp: string): Promise<void> {
    // Answering is an attempt too: the sweep must not dial a peer we are in the
    // middle of answering, or the two sides tear each other's work down.
    this.attemptAt.set(fromPeerId, Date.now());
    // Reuse the existing connection for a renegotiation (e.g. media tracks added
    // mid-call). Only create a fresh connection for a first-time offer — the old
    // "always recreate" behaviour would have torn down the live data channel.
    let pc = this.connections.get(fromPeerId);
    // …but a fresh ICE session (different ice-ufrag) under a known peerId means the
    // peer reconnected / reloaded: the stale pc's data channel is dead, and answering
    // on it would NOT surface the peer's new data channel (`ondatachannel` doesn't
    // re-fire on a renegotiation), so the peer would connect-but-stay-silent — no
    // name announce, no messages, just a hex id in the roster. Rebuild a clean pc
    // (which resurfaces the data channel) instead of renegotiating the corpse.
    if (pc && iceUfrag(pc.remoteDescription?.sdp) && iceUfrag(pc.remoteDescription?.sdp) !== iceUfrag(sdp)) {
      this.makingOffer.set(fromPeerId, false);
      pc = undefined;
    }
    if (!pc) pc = this.createPeerConnection(fromPeerId);
    // Both sides may create an offer at the same time. The polite side rolls
    // back its local offer and answers on the existing PC; it must still receive
    // the remote offerer's data channels. Installing this only for a newly
    // created PC silently drops the remote channels in the glare path.
    pc.ondatachannel = (event) => {
      const ch = event.channel;
      if (ch.label === "qos-stream") this.setupSocketChannel(fromPeerId, ch, "stream");
      else if (ch.label === "qos-dgram") this.setupSocketChannel(fromPeerId, ch, "dgram");
      else this.setupDataChannel(fromPeerId, ch);
    };

    // Perfect-negotiation glare handling: the peer with the smaller ID is polite.
    const polite = this.peerId < fromPeerId;
    const collision = (this.makingOffer.get(fromPeerId) ?? false) || pc.signalingState !== "stable";
    if (collision && !polite) return;   // impolite peer ignores — its own offer wins

    try {
      // When collision is raised only by makingOffer, createOffer may still
      // be pending and no local description exists yet. Rollback is only valid
      // once the local offer has actually changed signalingState.
      if (collision && polite && pc.signalingState !== "stable") {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription({ type: "offer", sdp });
      await this.flushPendingIce(fromPeerId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal({
        type: "answer",
        roomId: this.wireRoomId,
        from: this.peerId,
        to: fromPeerId,
        sdp: pc.localDescription!.sdp,
      });
    } catch (e) {
      console.warn("[qos-peer] handleOffer failed", e);
    }
  }

  private async handleAnswer(fromPeerId: string, sdp: string): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    if (!pc) return;
    if (pc.signalingState !== "have-local-offer") return;   // stray/rolled-back answer
    try {
      await pc.setRemoteDescription({ type: "answer", sdp });
      await this.flushPendingIce(fromPeerId, pc);
    } catch (e) { console.warn("[qos-peer] handleAnswer failed", e); }
  }

  private queueIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    const pending = this.pendingIce.get(peerId) ?? [];
    if (pending.length >= MAX_PENDING_ICE_PER_PEER) pending.shift();
    pending.push(candidate);
    this.pendingIce.set(peerId, pending);
  }

  private async flushPendingIce(peerId: string, pc: RTCPeerConnection): Promise<void> {
    if (!pc.remoteDescription) return;
    const pending = this.pendingIce.get(peerId);
    if (!pending?.length) return;

    const remoteUfrag = iceUfrag(pc.remoteDescription.sdp);
    const remaining: RTCIceCandidateInit[] = [];
    for (const candidate of pending) {
      const candidateUfrag = iceCandidateUfrag(candidate);
      // A mismatched ufrag may belong to the next ICE-restart offer, which can
      // itself arrive after its trickled candidates. Retain it, bounded, until
      // the matching remote description is installed.
      if (remoteUfrag && candidateUfrag && remoteUfrag !== candidateUfrag) {
        remaining.push(candidate);
        continue;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("[qos-peer] queued ICE candidate rejected", e);
      }
    }
    if (remaining.length) this.pendingIce.set(peerId, remaining);
    else this.pendingIce.delete(peerId);
  }

  private async handleIce(fromPeerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    const candidateUfrag = iceCandidateUfrag(candidate);
    const remoteUfrag = iceUfrag(pc?.remoteDescription?.sdp);
    if (!pc || !pc.remoteDescription ||
        (remoteUfrag && candidateUfrag && remoteUfrag !== candidateUfrag)) {
      this.queueIceCandidate(fromPeerId, candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      // A candidate can still race an SDP replacement. Preserve it for the next
      // matching description rather than silently losing a valid path.
      this.queueIceCandidate(fromPeerId, candidate);
      console.warn("[qos-peer] ICE candidate deferred", e);
    }
  }

  private createPeerConnection(remotePeerId: string): RTCPeerConnection {
    // Replacing our own connection is not the peer leaving.
    //
    // Closing a connection fires its state handlers, and those declare the peer
    // gone — so every retry produced a "left" and then a "joined" when the new
    // channel opened, which reads as a peer flapping when nothing of the sort
    // happened. Detach before closing: the old object has no further part in
    // this, and its last act should not be to lie about who is in the room.
    const stale = this.connections.get(remotePeerId);
    if (stale) {
      stale.onconnectionstatechange = null;
      stale.oniceconnectionstatechange = null;
      stale.onicegatheringstatechange = null;
      stale.onicecandidate = null;
      stale.ondatachannel = null;
      stale.ontrack = null;
      const ch = this.channels.get(remotePeerId);
      if (ch) { ch.onclose = null; ch.onopen = null; ch.onmessage = null; }
      stale.close();
    }

    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers ?? DEFAULT_ICE,
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.signal({
        type: "ice",
        roomId: this.wireRoomId,
        from: this.peerId,
        to: remotePeerId,
        candidate: event.candidate.toJSON(),
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.config.onRemoteTrack?.(remotePeerId, stream);
    };

    // ICE is where a connection that never completes actually stops, and its
    // state is the difference between "no candidate pair works" (a network that
    // cannot be crossed) and "checking forever" (candidates arriving too late,
    // or not at all). Neither is visible from the connection state alone.
    pc.oniceconnectionstatechange = () => {
      console.log(`[qos-peer] ice to ${remotePeerId.slice(-8)} → ${pc.iceConnectionState}`);
    };
    pc.onicegatheringstatechange = () => {
      console.log(`[qos-peer] gathering for ${remotePeerId.slice(-8)} → ${pc.iceGatheringState}`);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[qos-peer] connection to ${remotePeerId.slice(-8)} → ${state}`);
      if (state === "connected") {
        // Recovered (or first connected) — cancel any pending disconnect grace.
        this.clearDisconnectTimer(remotePeerId);
        return;
      }
      if (state === "failed" || state === "closed") {
        this.clearDisconnectTimer(remotePeerId);
        // "failed" means no candidate pair worked — we could not open a *direct*
        // path to this peer. That is NOT the same as "they left". If signaling
        // still lists them in the room they are present, and if there is a relay
        // overlay (an agent, another peer we share) their chat still reaches us.
        // Calling declarePeerGone here (→ onPeerLeft → the app drops them from
        // the roster) is what makes a cross-network peer with no working TURN
        // *vanish* for everyone they cannot dial directly, even while the room
        // works over the relay. Keep them: tear down the dead pc so the sweep
        // redials, back the retry off one cycle, and let the app mark them
        // unreachable (⚠) instead of gone. The authoritative "they left" is the
        // signaling "left" message; a peer we actually had a channel to also
        // reports departure through the data-channel onclose path.
        if (remotePeerId !== this.peerId && this.roster.has(remotePeerId)) {
          this.cleanup(remotePeerId);
          this.retryAt.set(remotePeerId, Date.now() + QOSPeer.RETRY_MIN_MS);
          return;
        }
        this.declarePeerGone(remotePeerId);
        return;
      }
      if (state === "disconnected") {
        // Possibly transient: start a grace timer, evict only if it does not
        // recover. Don't stack timers if one is already running.
        if (!this.disconnectTimers.has(remotePeerId)) {
          const t = setTimeout(() => {
            this.disconnectTimers.delete(remotePeerId);
            const cur = this.connections.get(remotePeerId)?.connectionState;
            if (cur === "connected") return;   // recovered
            // Same reasoning as "failed" above: a peer still in the signaling
            // roster is unreachable, not gone.
            if (this.roster.has(remotePeerId)) {
              this.cleanup(remotePeerId);
              this.retryAt.set(remotePeerId, Date.now() + QOSPeer.RETRY_MIN_MS);
              return;
            }
            this.declarePeerGone(remotePeerId);
          }, QOSPeer.DISCONNECT_GRACE_MS);
          this.disconnectTimers.set(remotePeerId, t);
        }
      }
    };

    this.connections.set(remotePeerId, pc);
    return pc;
  }

  private setupDataChannel(peerId: string, ch: RTCDataChannel): void {
    ch.onopen = () => {
      this.channels.set(peerId, ch);
      // It worked: forget the backoff, so a later failure starts from patient
      // rather than from wherever this one left off.
      this.retryAt.delete(peerId);
      this.retryN.delete(peerId);
      this.attemptAt.delete(peerId);
      this.config.onChannelOpen?.(peerId);
      console.log(`[qos-peer] data channel open with ${peerId}`);
      // If a call is already in progress, push our media to the newcomer (but never
      // to data-only agents — they'd echo it back and churn on the renegotiation).
      if (this.localStream && !this.dataOnly.has(peerId)) {
        const pc = this.connections.get(peerId);
        if (pc) {
          for (const t of this.localStream.getTracks()) {
            if (!pc.getSenders().some((s) => s.track === t)) pc.addTrack(t, this.localStream);
          }
          void this.renegotiate(peerId, pc);
        }
      }
    };
    ch.onclose = () => {
      this.channels.delete(peerId);
      console.log(`[qos-peer] data channel closed with ${peerId}`);
      // A closed data channel is a direct link gone, not a person gone: who is
      // in the room is the server's word (with its grace window), and a peer
      // it still lists gets our chat through the relay regardless. Tear the
      // dead pc down so the sweep can redial for calls/bulk, and if the
      // server has in fact forgotten them, say so.
      if (this.roster.has(peerId)) {
        this.cleanup(peerId);
        this.retryAt.set(peerId, Date.now() + QOSPeer.RETRY_MIN_MS);
        return;
      }
      this.declarePeerGone(peerId);
    };
    ch.onmessage = (event) => {
      let data: unknown;
      try { data = JSON.parse(event.data); }
      catch { this.config.onMessage?.(peerId, event.data); return; }
      // A tagged flood — either a broadcast, or a directed send() to a peer
      // we have no direct link to. Anything untagged is a direct message
      // exactly as before (old build or new, on either end) — unchanged.
      if (data && typeof data === "object" && typeof (data as Record<string, unknown>)._relayId === "string") {
        this.handleRelay(peerId, data as Record<string, unknown>);
        return;
      }
      this.config.onMessage?.(peerId, data);
    };
  }

  /**
   * A message tagged for the flood overlay. `_relayId` dedupes so a message
   * that reaches us by two paths (a ring link and its skip-link) is only
   * delivered/relayed once; `_hops` bounds how much farther it can travel;
   * `_relayTo`, if present, means only that one peer should actually receive
   * it — everyone else on the path still relays it onward without
   * delivering it, which is what lets a directed send() reach through
   * peers who aren't the target. `_from` is who actually sent it — not
   * `fromPeerId`, which is only the last hop.
   */
  private handleRelay(fromPeerId: string, data: Record<string, unknown>): void {
    const relayId = data._relayId as string;
    if (this.seenRelay.has(relayId)) return;
    this.seenRelay.add(relayId);
    if (this.seenRelay.size > QOSPeer.SEEN_RELAY_MAX) this.seenRelay.clear();

    const hopsLeft = typeof data._hops === "number" ? data._hops : 0;
    const relayTo = typeof data._relayTo === "string" ? data._relayTo : undefined;
    const from = typeof data._from === "string" ? data._from : fromPeerId;

    const cleaned = { ...data };
    delete cleaned._relayId;
    delete cleaned._hops;
    delete cleaned._from;
    delete cleaned._relayTo;

    this.lastHeardVia.set(from, Date.now());

    if (relayTo === undefined || relayTo === this.peerId) {
      this.config.onMessage?.(from, cleaned);
    }

    if (hopsLeft > 0) {
      const out: Record<string, unknown> = { ...cleaned, _relayId: relayId, _hops: hopsLeft - 1, _from: from };
      if (relayTo !== undefined) out._relayTo = relayTo;
      const payload = JSON.stringify(out);
      for (const [peerId, ch] of this.channels) {
        if (peerId === fromPeerId) continue;
        if (ch.readyState === "open") ch.send(payload);
      }
    }
  }

  private cleanup(peerId: string): void {
    this.connections.get(peerId)?.close();
    this.connections.delete(peerId);
    this.channels.delete(peerId);
    this.streamChannels.delete(peerId);
    this.dgramChannels.delete(peerId);
  }

  /**
   * DELIBERATELY INERT — does not arm any close timer. See prunePeer for why
   * it once did, and why that's off.
   *
   * Closing a working connection because ring math shifted turned out to have
   * a real cost: a roster change reshuffles ring positions for *everyone*,
   * so one flaky peer bouncing in and out of the room could cascade into
   * closing OTHER peers' entirely healthy connections as a side effect —
   * amplifying one device's instability into churn across the room, observed
   * live during testing. The grace period (PRUNE_GRACE_MS) bounded how often
   * that could happen, not whether it could.
   *
   * So: targetPeers() / ringSkipNeighbors still bound who gets *newly*
   * dialled (the actual fix for the join-burst / signaling rate-limit
   * problem this overlay exists for), but an already-open connection is now
   * never actively closed just because it fell outside the ring. Degree
   * can only grow past 4 over a long session with a lot of churn passing
   * through, never shrink back — an accepted tradeoff for never being the
   * cause of a working connection dropping. prunePeer/clearPruneTimer stay
   * in place (and covered by tests) so this can be re-enabled deliberately,
   * behind something better than a fixed per-peer grace timer — e.g. only
   * pruning once the *room*, not just one peer, has been stable for a while.
   */
  private reconcilePrune(): void {
    // no-op — see above
  }

  private clearPruneTimer(peerId: string): void {
    const t = this.pruneTimers.get(peerId);
    if (t !== undefined) { clearTimeout(t); this.pruneTimers.delete(peerId); }
  }

  /// Close a direct link that fell outside the target neighbor set. Not a
  /// departure — the peer is (usually) still in the room, just no longer a
  /// direct neighbor — so unlike declarePeerGone this must not fire
  /// onPeerLeft. It doesn't need to: cleanup() empties connections/channels
  /// synchronously, before the data channel's own onclose can fire, so
  /// declarePeerGone's "had" idempotency guard (see below) already finds
  /// nothing left to report by the time that async event lands.
  private prunePeer(peerId: string): void {
    this.clearPruneTimer(peerId);
    this.cleanup(peerId);
  }

  private clearDisconnectTimer(peerId: string): void {
    const t = this.disconnectTimers.get(peerId);
    if (t !== undefined) { clearTimeout(t); this.disconnectTimers.delete(peerId); }
  }

  /// Tear down a peer's connection and notify the app it left. Idempotent: a
  /// data-channel close and a connection-state "failed" for the same peer both
  /// land here, but the second call is a no-op (nothing left to clean up).
  private declarePeerGone(peerId: string): void {
    this.clearDisconnectTimer(peerId);
    const had = this.connections.has(peerId) || this.channels.has(peerId);
    this.cleanup(peerId);
    if (had) this.config.onPeerLeft?.(peerId);
  }

  private signal(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.lastSentType = String((msg as { type?: unknown })?.type ?? "");
      this.ws.send(JSON.stringify(msg));
    }
  }
}
