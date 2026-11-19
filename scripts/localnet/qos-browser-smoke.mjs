#!/usr/bin/env node
// #601 browser acceptance: two independent Chromium contexts on the disposable
// local harness. The room capability is supplied via environment and is never
// printed, written to disk, attached to traces, or included in failure text.
import { pathToFileURL } from "node:url";

const roomUrlRaw = process.env.QOS_BROWSER_URL;
const playwrightModule = process.env.QOS_PLAYWRIGHT_MODULE;
if (!roomUrlRaw || !playwrightModule) {
  throw new Error("requires QOS_BROWSER_URL and QOS_PLAYWRIGHT_MODULE");
}

const { chromium } = await import(pathToFileURL(playwrightModule).href);
const roomUrl = new URL(roomUrlRaw);
if (roomUrl.protocol !== "https:" || roomUrl.pathname !== "/quantum-os/") {
  throw new Error("refusing unexpected browser origin/path");
}
roomUrl.searchParams.set("signal", `wss://${roomUrl.host}/signal`);

const nonce = `qos601-${Date.now().toString(36)}`;
const marker = `QOS601_CHAT_${nonce}`;
const goal = `QOS601_GOAL_${nonce}`;
const processName = `QOS601_PROCESS_${nonce}`;
const checks = [];
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const pages = [];

function check(label, ok) {
  checks.push({ label, ok: Boolean(ok) });
  if (!ok) throw new Error(`browser acceptance failed: ${label}`);
}

async function waitForTranscript(page, needle, label, timeout = 20_000) {
  await page.waitForFunction(
    (text) => document.querySelector("#messages")?.innerText.includes(text) ?? false,
    needle,
    { timeout },
  );
  check(label, true);
}

async function sendCommand(page, command) {
  const input = page.locator("#msg-input");
  await input.fill(command);
  await input.press("Enter");
}

try {
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    pages.push(page);
    await page.goto(roomUrl.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator("#connect-btn").waitFor({ state: "visible", timeout: 30_000 });
  }
  const [a, b] = pages;

  await a.locator("#connect-btn").click();
  await a.waitForFunction(
    () => document.querySelector("#status-dot")?.classList.contains("connected") ?? false,
    null,
    { timeout: 30_000 },
  );
  await b.locator("#connect-btn").click();
  await b.waitForFunction(
    () => document.querySelector("#status-dot")?.classList.contains("connected") ?? false,
    null,
    { timeout: 30_000 },
  );
  check("both independent browser sessions connected to signaling", true);

  for (const page of pages) {
    await page.waitForFunction(
      () => document.querySelectorAll("#peer-list li").length >= 2,
      null,
      { timeout: 30_000 },
    );
  }
  check("both browser sessions discovered the other room member", true);

  // /conn reports the actual RTCDataChannel state. A WebSocket roster entry
  // alone cannot satisfy this assertion.
  await sendCommand(a, "/conn");
  await a.waitForFunction(
    () => /channel open\s+conn connected/i.test(document.querySelector("#messages")?.innerText ?? ""),
    null,
    { timeout: 30_000 },
  );
  await sendCommand(b, "/conn");
  await b.waitForFunction(
    () => /channel open\s+conn connected/i.test(document.querySelector("#messages")?.innerText ?? ""),
    null,
    { timeout: 30_000 },
  );
  check("both sides report an open direct WebRTC data channel", true);

  await sendCommand(a, marker);
  await waitForTranscript(b, marker, "browser-to-browser chat reached the second browser");

  await sendCommand(a, `/goal add ${goal} | important`);
  await waitForTranscript(a, "🎯 added", "personal /goal add executed in the browser");
  await sendCommand(a, "/goal list");
  await waitForTranscript(a, "personal goals (", "personal /goal list returned the stored goal");

  await sendCommand(a, `/qos start ${processName}`);
  await waitForTranscript(a, `started **${processName}**`, "browser /qos start created a local signed process");
  await sendCommand(a, `/qos status ${processName}`);
  await waitForTranscript(a, "events:", "browser /qos status reports process state and event count");
  await sendCommand(a, "/qos ps");
  await waitForTranscript(a, "QOS process table (", "browser /qos ps rendered the process table");

  console.log("QOS #601 browser acceptance: PASS");
  for (const item of checks) console.log(`PASS: ${item.label}`);
  console.log("Coverage: 2 Chromium contexts; signaling membership; direct WebRTC data channels; chat; /goal add+list; /qos start+status+ps.");
} finally {
  await browser.close();
}
