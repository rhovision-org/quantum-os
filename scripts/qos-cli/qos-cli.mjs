#!/usr/bin/env node
// QuantumOS headless CLI peer.
//
// Joins a room by its capability token, connects to the live peers through the
// same `QOSPeer` the browser and the daemons use, broadcasts a chat message,
// and exits. That matters for interop: `QOSPeer` hashes the capability into the
// signaling room id (`roomIdFor`) and seals data frames under the room key
// (`deriveRoomKey`/`seal`). The previous hand-rolled peer did neither, so it
// looked connected while sitting in a different signaling room and sending
// plaintext frames no browser would decode.
//
// IMPORTANT — QuantumOS rooms are pure peer-to-peer. The signaling server only
// routes WebRTC handshakes; there is NO server-side room or message history.
// A broadcast reaches only the peers connected *right now*. If nobody is in the
// room, the message goes nowhere. (This is by design — see CLAUDE.md.)

import { QOSPeer } from "./qospeer.mjs";
import { generateCapability, validateCapability } from "./zfa.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
const DEFAULT_STUN = "stun:stun.l.google.com:19302";

// Build the ICE server list from --stun / --turn flags (mirrors the browser's
// /ice command). A relay (turn:) is what lets two peers behind restrictive NAT
// connect at all — STUN alone can't cross that. When neither flag is given we
// leave iceServers undefined so QOSPeer fetches the server's short-lived TURN
// credentials, exactly like the browser.
function buildIce(a) {
  const list = [{ urls: a.stun || DEFAULT_STUN }];
  for (const t of a.turn) {
    const [urls, username = "", credential = ""] = t.split(",").map((s) => s.trim());
    if (urls) list.push(username ? { urls, username, credential } : { urls });
  }
  return list;
}

const USAGE = `qos-cli — headless QuantumOS room peer

Usage:
  node qos-cli.mjs --room <cap:room:… | room-URL> --message "text" [options]
  node qos-cli.mjs --room <…> --listen        # stay and print room chat

Options:
  --room <cap|url>   Room capability token, or a full rhovision-org.github.io/quantum-os
                     URL whose #room=… fragment carries the cap. (required)
  --message, -m <s>  Text to broadcast to the room.
  --name <s>         Display name shown to peers (default: "qos-cli").
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --stun <url>       STUN server (default: ${DEFAULT_STUN}).
  --turn <u,user,pw> TURN relay, repeatable: "turn:host:3478,user,pass" (or just
                     "turn:host:3478"). Needed when both peers are behind a
                     restrictive NAT — STUN alone can't cross that.
  --wait <ms>        Give up if no peer is reached in this long (default 15000).
  --linger <ms>      Stay this long after delivery before exiting (default 2000).
  --listen           Don't send; stay connected and print incoming messages.
  --help, -h         Show this help.

Note: rooms are p2p — a message only lands if someone is in the room now.`;

function parseArgs(argv) {
  const a = { signal: DEFAULT_SIGNAL, name: "qos-cli", waitMs: 15000, lingerMs: 2000, listen: false, stun: "", turn: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--message" || x === "-m") a.message = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
    else if (x === "--name") a.name = argv[++i];
    else if (x === "--wait") a.waitMs = Number(argv[++i]);
    else if (x === "--linger") a.lingerMs = Number(argv[++i]);
    else if (x === "--stun") a.stun = argv[++i];
    else if (x === "--turn") a.turn.push(argv[++i]);
    else if (x === "--listen") a.listen = true;
    else if (x === "--help" || x === "-h") a.help = true;
    else rest.push(x);
  }
  if (!a.message && rest.length) a.message = rest.join(" ");
  return a;
}

// Accept a bare cap:room:…, or any URL with a #room=<url-encoded cap> fragment.
function extractRoomCap(s) {
  if (!s) return null;
  if (s.startsWith("cap:room:")) return s;
  const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const m = /room=([^&]+)/.exec(frag);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return s.startsWith("cap:") ? s : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.room) { console.log(USAGE); process.exit(args.help ? 0 : 1); }

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) {
    console.error("[qos-cli] could not parse a cap:room: token from --room"); process.exit(1);
  }
  if (!validateCapability(roomId)) {
    console.warn(`[qos-cli] warning: room token failed ZFA validation (continuing): ${roomId}`);
  }
  if (!args.listen && !args.message) {
    console.error("[qos-cli] nothing to do: pass --message <text> or --listen"); process.exit(1);
  }

  const peerId = generateCapability("peer");
  const explicitIce = !!(args.stun || args.turn.length);
  const iceServers = explicitIce ? buildIce(args) : undefined;
  console.log(`[qos-cli] peer ${peerId.slice(0, 18)}…  room ${roomId.slice(0, 18)}…  signal ${args.signal}`);
  if (args.turn.length) console.log(`[qos-cli] ${iceServers.length} ICE server(s), incl. ${args.turn.length} relay`);

  let finished = false;
  let nameSent = false;
  let sent = false;
  let waitTimer = null;
  let lingerTimer = null;

  const finish = (code = 0) => {
    if (finished) return;
    finished = true;
    if (waitTimer) clearTimeout(waitTimer);
    if (lingerTimer) clearTimeout(lingerTimer);
    try { peer.disconnect(); } catch { /* already gone */ }
    setTimeout(() => process.exit(code), 150);
  };

  const peer = new QOSPeer({
    signalingUrl: args.signal,
    roomId,
    peerId,
    // Explicit --stun/--turn means the caller supplied the whole ICE list;
    // otherwise leave it undefined so QOSPeer fetches the relay credentials.
    iceServers,
    noAutoTurn: explicitIce,
    onSignalingOpen: () => console.log("[qos-cli] signaling connected; joined room"),
    onSignalingClose: () => console.log("[qos-cli] signaling closed"),
    onSignalingError: (message) => console.error("[qos-cli] signaling:", message),
    onPeerReady: (id) => {
      console.log(`[qos-cli] peer ${id.slice(0, 14)}… ready`);
      if (!nameSent) {
        nameSent = true;
        peer.broadcast({ kind: "name", name: args.name });
      }
      if (args.listen || sent) return;
      sent = true;
      if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
      peer.broadcast({ kind: "chat", text: args.message });
      console.log(`[qos-cli] → sent to ${id.slice(0, 14)}…; lingering ${args.lingerMs}ms`);
      lingerTimer = setTimeout(() => finish(0), args.lingerMs);
    },
    onMessage: (from, data) => {
      const tag = `${from.slice(0, 8)}…`;
      if (!data || typeof data !== "object") {
        if (args.listen) console.log(`[${tag}] ${String(data).slice(0, 500)}`);
        return;
      }
      if (data.kind === "name") { console.log(`[qos-cli] peer ${tag} is "${data.name}"`); return; }
      if (data.kind === "chat" || "text" in data) {
        console.log(`[${tag}] ${data.text ?? data.message ?? JSON.stringify(data)}`);
        return;
      }
      // One-shot mode is waiting for an answer, not a room-state dump; only
      // --listen prints the bulk sync/control envelopes.
      if (!args.listen) return;
      if (data.kind === "qlf") console.log(`[${tag} /${data.cmd}] ${(data.lines || []).join(" | ")}`);
      else console.log(`[${tag}] ${JSON.stringify(data).slice(0, 500)}`);
    },
    onError: (e) => console.error("[qos-cli]", e?.message ?? e),
  });

  if (args.listen) {
    console.log("[qos-cli] listening… (Ctrl-C to exit)");
    process.on("SIGINT", () => finish(0));
  } else {
    // A one-shot send must terminate even when nobody is in the room.
    waitTimer = setTimeout(() => {
      if (sent) return;
      console.error(`[qos-cli] no peers reached within ${args.waitMs}ms — message NOT delivered (rooms are p2p; someone must be in the room).`);
      finish(2);
    }, args.waitMs);
  }

  peer.connect();
}

main().catch((e) => { console.error(e); process.exit(1); });
