#!/usr/bin/env node
// #601 CI-only, two independent WebSocket signaling clients.
// Not a browser WebRTC/media/chat-encryption acceptance test.
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { generateCapability } from "./zfa.mjs";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("CI-only signal smoke");
const roomId = generateCapability("room");
const idA = "qos601-signal-a", idB = "qos601-signal-b";
const signal = "ws://127.0.0.1:4444";
const clients = [];
const observed = { aJoined: false, bSeesA: false, aSeesB: false, opaqueRelay: false };
const ready = () => observed.aJoined && observed.bSeesA && observed.aSeesB && observed.opaqueRelay;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  const a = new WebSocket(signal);
  clients.push(a);
  await new Promise((resolve, reject) => {
    a.once("open", resolve);
    a.once("error", reject);
  });
  a.on("message", (input) => {
    const m = JSON.parse(String(input));
    if (m.type === "peers") observed.aJoined = true;
    if (m.type === "joined" && m.peerId === idB) observed.aSeesB = true;
  });
  a.send(JSON.stringify({ type: "join", roomId, peerId: idA }));
  await wait(150);
  const b = new WebSocket(signal);
  clients.push(b);
  await new Promise((resolve, reject) => {
    b.once("open", resolve);
    b.once("error", reject);
  });
  b.on("message", (input) => {
    const m = JSON.parse(String(input));
    if (m.type === "peers" && m.peers.includes(idA)) {
      observed.bSeesA = true;
    }
    if (m.type === "data" && m.from === idA && m.payload === "opaque-ci-probe") {
      observed.opaqueRelay = true;
    }
  });
  b.send(JSON.stringify({ type: "join", roomId, peerId: idB }));
  for (let i = 0; i < 40 && !observed.aSeesB; i++) await wait(100);
  a.send(JSON.stringify({ type: "data", roomId, from: idA, to: idB, payload: "opaque-ci-probe" }));
  for (let i = 0; i < 40 && !ready(); i++) await wait(100);
  if (!ready()) throw new Error("signaling visibility / data relay incomplete");
  writeFileSync("qos601-signaling.json",
    JSON.stringify({ record_type: "qos601_ci_two_websocket_peers",
      observed, client_type: "standalone WebSocket (NOT WebRTC browser)",
      room_capability_retained: false,
      recorded_utc: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  console.log("Signaling two-peer discovery and opaque relay: PASS");
} finally {
  for (const ws of clients) try { ws.close(); } catch {}
}
// Capability and raw control envelopes never enter CI logs or artifacts.
