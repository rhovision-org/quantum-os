// e2e: the one-shot CLI peer must land in the same room as QOSPeer.
//
// This is the regression test for the old hand-rolled transport: it joined
// signaling with the raw cap (QOSPeer hashes it with `roomIdFor`) and sent
// plaintext frames (QOSPeer seals them), so it silently saw no peers. The test
// starts the real `qos-cli.mjs`, joins with a real QOSPeer, and requires the
// CLI's message to arrive and the peer's reply to come back.
//
// Run: node qos-cli.e2e.mjs

import { startRelay } from "./mini-relay.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 4462;
const ROOM = generateCapability("room");
const { wss } = startRelay(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (cond, msg, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
  if (!cond) fail++;
};

let out = "";
let err = "";
const child = spawn(process.execPath, [
  join(here, "qos-cli.mjs"),
  "--room", ROOM,
  "--signal", `ws://127.0.0.1:${PORT}`,
  "--name", "cli-e2e",
  "--message", "hello from cli",
  "--wait", "15000",
  "--linger", "4000",
], { cwd: here, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { err += d.toString(); });
const childClosed = new Promise((resolve) => child.on("close", resolve));

const received = [];
const driver = new QOSPeer({
  signalingUrl: `ws://127.0.0.1:${PORT}`,
  roomId: ROOM,
  peerId: generateCapability("peer"),
  onMessage: (_from, data) => {
    if (data?.kind === "chat") {
      received.push(data.text);
      if (data.text === "hello from cli") {
        driver.broadcast({ kind: "chat", text: "hello from peer" });
      }
    }
  },
  onError: () => {},
});
driver.connect();

const waitFor = async (needle, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if (out.includes(needle)) return true;
    await sleep(250);
  }
  return false;
};

try {
  for (let i = 0; i < 80 && driver.channels.size === 0; i++) await sleep(250);
  ok(driver.channels.size > 0, "the driver reached the CLI peer");

  const cliSaysHello = await waitFor("→ sent to");
  ok(cliSaysHello, "the CLI announced delivery", err.slice(-300));
  ok(received.includes("hello from cli"), "the driver recorded the CLI's chat");

  const replyReachedCli = await waitFor("hello from peer");
  ok(replyReachedCli, "the QOSPeer's reply reached the CLI", out.slice(-400));

  const code = await childClosed;
  ok(code === 0, `the CLI exited 0 (got ${code})`, err.slice(-300));
  ok(out.includes("signaling connected"), "the CLI connected through QOSPeer");
  ok(!/no peers reached/.test(out + err), "the CLI did not report an empty room");
} catch (e) {
  fail++;
  console.error("TEST ERROR:", e?.stack ?? e);
} finally {
  try { child.kill(); } catch {}
  try { driver.disconnect(); } catch {}
  try { wss.close(); } catch {}
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: qos-cli.e2e.mjs`);
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200);
}
