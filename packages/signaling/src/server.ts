import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Room, type Peer } from "./room.js";
import { getTurnCredentials, turnConfigured } from "./turn.js";

/// Wire message types for WebRTC signaling.
type SignalMsg =
  | { type: "join";      roomId: string; peerId: string }
  | { type: "offer";     roomId: string; from: string; to: string; sdp: string }
  | { type: "answer";    roomId: string; from: string; to: string; sdp: string }
  | { type: "ice";       roomId: string; from: string; to: string; candidate: unknown }
  | { type: "leave";     roomId: string; peerId: string }
  // App-level liveness for browsers, which cannot send a protocol ping and
  // whose OS drops the TCP under a backgrounded tab while the WebSocket still
  // claims OPEN. Any reply proves the socket; `t` is echoed for a round trip.
  | { type: "ping";      t?: number }
  | { type: "pong";      t?: number }
  // The control plane: one sealed envelope (see packages/browser/src/room-crypto.js)
  // from a peer to one peer (`to`) or to the room. The server relays the
  // ciphertext and queues it for a grace-held peer; it can open none of it.
  | { type: "data";      roomId: string; from: string; to?: string; payload: string }
  | { type: "peers";     roomId: string; peers: string[]; resumed?: boolean }   // server → client
  | { type: "joined";    roomId: string; peerId: string }    // server → others
  | { type: "left";      roomId: string; peerId: string }    // server → others
  | { type: "error";     message: string };

/**
 * Validate an inbound frame before dispatching it.
 *
 * `SignalMsg` is a *claim* about parsed JSON, not a guarantee: the wire is
 * untrusted and a peer can send `{"type":"join"}` with no roomId or peerId.
 * Without this check that join registered a peer under the key `undefined`
 * (the throw inside `onJoin` was swallowed by the `invalid JSON` catch, after
 * the index had already been poisoned), and the socket's later `close` ran
 * `onLeave` with an undefined peerId — outside any try/catch, so the
 * `peerId.slice(-8)` TypeError killed the process. Any client could take the
 * signaling server down for every room by connecting, sending a malformed
 * join, and hanging up.
 */
function isWellFormed(msg: SignalMsg): boolean {
  const str = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  switch (msg.type) {
    case "join":
    case "leave":
      return str(msg.roomId) && str(msg.peerId);
    case "offer":
    case "answer":
    case "ice":
      return str(msg.roomId) && str(msg.from) && str(msg.to);
    case "data":
      return str(msg.roomId) && str(msg.from) && str(msg.payload)
        && (msg.to === undefined || str(msg.to));
    default:
      return true;   // unknown types are answered by the dispatcher below
  }
}

// Max messages per window per connection. The default is what the public
// deployment runs and is deliberately tight, but it is also the ceiling on how
// many peers a room can hold: a peer joining a room of N sends N-1 offers and
// then a burst of ICE candidates, so the join cost per peer is superlinear and
// blows the window well before the room feels large. Over it, handshakes stop
// completing while every peer still appears in the room — indistinguishable,
// from a browser, from the other peers never having started.
//
// The default is 200 because a default that breaks a four-peer room is not
// protecting anything. It was 20, chosen to be tight, and what it actually did
// was stop handshakes completing while every peer still appeared in the room —
// the failure this file's comments describe. What guards this server is the
// 64 KB payload cap and the wsIndex relay auth; a low message rate adds
// nothing to either, and an abuser would open more connections rather than
// send faster on one.
//
// Still env-overridable, and render.yaml sets it explicitly — but only a
// blueprint-managed service reads that file, so the default is what a
// hand-created service actually runs.
const RATE_LIMIT = parseInt(process.env.SIGNAL_RATE_LIMIT ?? "200", 10);
const RATE_WINDOW_MS = parseInt(process.env.SIGNAL_RATE_WINDOW_MS ?? "1000", 10);
// Joining is bursty and then quiet: offers and their ICE candidates arrive in a
// clump and nothing follows. A fixed window punishes exactly that shape, so the
// limit is a token bucket — RATE_LIMIT per window sustained, with a bucket deep
// enough to absorb one join. The sustained rate is what protects the server;
// the burst is what makes a legitimate join land.
const RATE_BURST = parseInt(process.env.SIGNAL_RATE_BURST ?? String(RATE_LIMIT * 4), 10);

// Build marker — surfaced at GET / so a deploy can be confirmed from outside
// (`curl https://…/` shows the live build). Bump this string on each meaningful deploy.
const BUILD = "2026-09-18-resume-relay";

/**
 * How long a peer whose socket died stays in the room, waiting to come back.
 *
 * A socket dying is not a person leaving: a phone switching apps, a laptop
 * lid, a wifi handoff, this process restarting under everyone at once — every
 * one of those used to become a `left` to the whole room, each peer tearing
 * down and redialling, and a `joined` seconds later when the socket came back.
 * That storm was most of what "people keep getting dropped" meant. So a lost
 * socket now HOLDS the seat: nobody else is told, control-plane traffic for
 * the seat is queued, and a rejoin under the same peerId inside the window
 * resumes silently (Jitsi's XMPP session resume, in one map). An explicit
 * `leave` (the browser sends one on pagehide) is still immediate — a person
 * who closes the tab is gone at once; only a person who *vanished* is waited
 * for. The server's own heartbeat (2 missed pongs, ~60s) is what turns a
 * silent zombie into a lost socket, so a peer that truly evaporated is seen
 * to leave within this plus that.
 */
export const GRACE_MS = parseInt(process.env.SIGNAL_GRACE_MS ?? "60000", 10);

/**
 * The largest frame a socket may send; `ws` closes the socket (1009) over it.
 * Was 64 KB when the socket carried handshakes alone. The control plane's
 * `sync-*` envelopes (a room's lemmas, polls, groups, library index — sealed
 * and base64, +33%) ride it now, and a socket dying on every join because the
 * room has grown is not a failure mode to keep. 256 KB holds a large room's
 * state; the rate limit above is what bounds abuse. The clients refuse to
 * send a frame over this rather than be cut off (peer.ts / qospeer.mjs
 * FRAME_MAX), and `GET /` reports it.
 */
export const MAX_PAYLOAD = parseInt(process.env.SIGNAL_MAX_PAYLOAD ?? String(256 * 1024), 10);

export class SignalingServer {
  private wss: WebSocketServer;
  private rooms = new Map<string, Room>();
  // peerId → { roomId, ws } for cleanup on disconnect
  private peerIndex = new Map<string, { roomId: string; ws: WebSocket }>();
  // ws → peerId for relay authentication
  private wsIndex = new Map<WebSocket, string>();
  // ws → rate-limit state
  private rateMap = new Map<WebSocket, { tokens: number; last: number }>();

  constructor(private port: number) {
    // HTTP server handles health checks (GET /), TURN credential minting
    // (GET /turn), and WS upgrades.
    const http = createServer((req, res) => {
      if (req.url === "/turn") {
        // A browser fetches this directly (not over the WS) — cross-origin
        // from GitHub Pages, so it needs its own CORS header. The response is
        // a short-lived Cloudflare-minted credential, not a secret to guard
        // per-origin: anyone who already knows this signaling URL can reach
        // this endpoint the same way they reach the room.
        getTurnCredentials()
          .then((server) => {
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ iceServers: server ? [server] : [] }));
          })
          .catch(() => {
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ iceServers: [] }));
          });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      // The limit is reported because it is the room ceiling and it comes from
      // the environment: a deploy proves the code shipped, and proves nothing
      // about the env it shipped into. Inferring it by tripping the limiter
      // from outside works and should not be necessary. `turn` is the same
      // idea applied to the relay: whether a call can survive two different
      // networks depends on env vars a deploy doesn't prove were set.
      res.end(JSON.stringify({
        status: "ok", build: BUILD, rooms: this.rooms.size,
        limit: RATE_LIMIT, burst: RATE_BURST, windowMs: RATE_WINDOW_MS,
        maxPayload: MAX_PAYLOAD, graceMs: GRACE_MS,
        turn: turnConfigured(),
      }));
    });
    this.wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });
    this._http = http;
  }

  private _http: ReturnType<typeof createServer>;

  start(): void {
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this._http.listen(this.port, process.env.SIGNAL_HOST || undefined, () => {
      console.log(`[quantum-os signaling] listening on ws://${process.env.SIGNAL_HOST || "0.0.0.0"}:${this.port}`);
    });

    // Ping every 30s to keep the proxy from closing idle WebSocket connections.
    // Browsers (and the Node `ws` client) respond to protocol-level pings automatically.
    // Terminate only after TWO consecutive missed pongs (~60s of silence), NOT one: a
    // free/throttled host is often slow or sleepy, and a single late pong used to
    // false-terminate a perfectly good connection — dropping every peer at once and
    // producing the correlated join/leave churn. This mirrors the agent's own heartbeat
    // (`qospeer.mjs`), which was hardened the same way for the same reason.
    const heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        const w = ws as WebSocket & { _missed?: number };
        if ((w._missed ?? 0) >= 2) { w.terminate(); continue; }
        w._missed = (w._missed ?? 0) + 1;
        try { w.ping(); } catch { /* socket already closing */ }
      }
    }, 30_000);
    this.wss.on("close", () => clearInterval(heartbeat));
    this._heartbeat = heartbeat;
  }

  /// Close every socket and the listener; grace timers are cleared with the rooms.
  stop(): void {
    if (this._heartbeat) clearInterval(this._heartbeat);
    for (const room of this.rooms.values()) for (const id of room.peerIds()) room.remove(id);
    this.rooms.clear();
    for (const ws of this.wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
    this.wss.close();
    this._http.close();
  }
  private _heartbeat: ReturnType<typeof setInterval> | null = null;

  private onConnect(ws: WebSocket): void {
    const w = ws as WebSocket & { _missed?: number };
    w._missed = 0;
    w.on("pong", () => { w._missed = 0; });

    this.rateMap.set(ws, { tokens: RATE_BURST, last: Date.now() });

    ws.on("message", (data) => {
      if (!this.checkRate(ws)) {
        this.send(ws, { type: "error", message: "rate limit exceeded" });
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as SignalMsg;
        this.handle(ws, msg);
      } catch {
        this.send(ws, { type: "error", message: "invalid JSON" });
      }
    });

    // A throw here runs outside the message handler's try/catch, so an
    // uncaught one ends the process and every room with it. Contain it.
    ws.on("close", () => {
      try {
        this.onDisconnect(ws);
      } catch (err) {
        console.error("[disconnect] cleanup failed:", err);
      }
    });
  }

  private checkRate(ws: WebSocket): boolean {
    const now = Date.now();
    const state = this.rateMap.get(ws);
    if (!state) return false;
    // Refill by however long it has been, cap at the bucket depth, spend one.
    const refill = ((now - state.last) / RATE_WINDOW_MS) * RATE_LIMIT;
    state.tokens = Math.min(RATE_BURST, state.tokens + refill);
    state.last = now;
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  private handle(ws: WebSocket, msg: SignalMsg): void {
    if (!msg || typeof msg.type !== "string") {
      this.send(ws, { type: "error", message: "malformed message" });
      return;
    }
    if (!isWellFormed(msg)) {
      this.send(ws, { type: "error", message: `malformed ${msg.type}: missing required field` });
      return;
    }
    switch (msg.type) {
      case "join":
        this.onJoin(ws, msg.roomId, msg.peerId);
        break;
      case "offer":
      case "answer":
      case "ice":
        this.relay(ws, msg);
        break;
      case "data":
        this.relayData(ws, msg);
        break;
      case "ping":
        this.send(ws, { type: "pong", t: msg.t });
        break;
      case "leave":
        // Only your own seat. Before this check any socket could send a
        // `leave` naming any peer and have the room told they had gone.
        if (this.wsIndex.get(ws) !== msg.peerId) {
          this.send(ws, { type: "error", message: "leave peerId mismatch" });
          return;
        }
        this.onLeave(msg.roomId, msg.peerId);
        break;
      default:
        this.send(ws, { type: "error", message: `unknown message type: ${msg.type}` });
    }
  }

  private onJoin(ws: WebSocket, roomId: string, peerId: string): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }

    // A socket may only ever speak for one peer; a second join on the same
    // socket under a different id would leave the first seat held forever.
    const prior = this.wsIndex.get(ws);
    if (prior && prior !== peerId) this.onLeave(this.peerIndex.get(prior)?.roomId ?? roomId, prior);

    const existing = room.get(peerId);
    if (existing) {
      // Same seat, new socket: a RESUME. Either the peer is grace-held (its
      // socket died and this is it coming back) or its old socket is a zombie
      // the heartbeat hasn't reaped yet (a phone that reconnected before we
      // noticed the old one was dead). Either way the seat is theirs: swap the
      // socket in, tell nobody, replay what they missed.
      const stale = existing.ws;
      if (stale && stale !== ws) {
        this.wsIndex.delete(stale);
        try { stale.terminate(); } catch { /* already gone */ }
      }
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      existing.ws = ws;
      this.peerIndex.set(peerId, { roomId, ws });
      this.wsIndex.set(ws, peerId);
      this.send(ws, { type: "peers", roomId, peers: room.peerIds().filter(id => id !== peerId), resumed: true });
      const replayed = room.flush(existing);
      console.log(`[resume] room=…${roomId.slice(-8)} peer=…${peerId.slice(-8)} replayed=${replayed} size=${room.size}`);
      return;
    }

    const peer: Peer = { id: peerId, ws, joinedAt: Date.now(), graceTimer: null, queue: [], queuedBytes: 0 };
    room.add(peer);
    this.peerIndex.set(peerId, { roomId, ws });
    this.wsIndex.set(ws, peerId);

    // Tell the joiner who else is in the room.
    this.send(ws, { type: "peers", roomId, peers: room.peerIds().filter(id => id !== peerId), resumed: false });

    // Tell existing peers that someone joined.
    room.broadcast(peerId, { type: "joined", roomId, peerId });

    console.log(`[join]  room=…${roomId.slice(-8)} peer=…${peerId.slice(-8)} size=${room.size}`);
  }

  /// The socket under a seat died. Hold the seat for GRACE_MS rather than
  /// announce a departure — see GRACE_MS.
  private holdSeat(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    const peer = room?.get(peerId);
    if (!room || !peer) return;
    if (peer.ws) { this.wsIndex.delete(peer.ws); peer.ws = null; }
    if (peer.graceTimer) clearTimeout(peer.graceTimer);
    peer.graceTimer = setTimeout(() => {
      peer.graceTimer = null;
      // Still held (no resume swapped a socket in) → now they have left.
      if (room.get(peerId) === peer && peer.ws === null) this.onLeave(roomId, peerId);
    }, GRACE_MS);
    console.log(`[hold]  room=…${roomId.slice(-8)} peer=…${peerId.slice(-8)} grace=${GRACE_MS}ms`);
  }

  private onLeave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const entry = this.peerIndex.get(peerId);
    room.remove(peerId);
    this.peerIndex.delete(peerId);
    if (entry) this.wsIndex.delete(entry.ws);
    room.broadcast(peerId, { type: "left", roomId, peerId });
    if (room.isEmpty) this.rooms.delete(roomId);
    console.log(`[leave] room=…${roomId.slice(-8)} peer=…${peerId.slice(-8)}`);
  }

  private onDisconnect(ws: WebSocket): void {
    this.rateMap.delete(ws);
    // Find the single peer on this socket and hold its seat (a resume within
    // GRACE_MS is silent; only the grace timer's expiry is a departure).
    const peerId = this.wsIndex.get(ws);
    if (!peerId) return;
    const entry = this.peerIndex.get(peerId);
    if (!entry || entry.ws !== ws) return;   // a newer socket already took the seat
    this.holdSeat(entry.roomId, peerId);
  }

  private relay(ws: WebSocket, msg: Extract<SignalMsg, { to: string; from: string; roomId: string }>): void {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;
    if (this.wsIndex.get(ws) !== msg.from) {
      this.send(ws, { type: "error", message: "relay from mismatch" });
      return;
    }
    room.send(msg.to, msg);
  }

  /// The control plane. Authenticated exactly like a handshake (`from` must be
  /// the socket's own seat) and then relayed unread — to one peer or to the
  /// room — queued for whoever is grace-held so a blip drops nothing.
  private relayData(ws: WebSocket, msg: Extract<SignalMsg, { type: "data" }>): void {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;
    if (this.wsIndex.get(ws) !== msg.from) {
      this.send(ws, { type: "error", message: "relay from mismatch" });
      return;
    }
    if (msg.to !== undefined) room.send(msg.to, msg, true);
    else room.broadcast(msg.from, msg, true);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(msg));
    }
  }
}
