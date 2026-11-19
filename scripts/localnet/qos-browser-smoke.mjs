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
const nameA = `QOS601_A_${nonce}`;
const nameB = `QOS601_B_${nonce}`;
const checks = [];
let stage = "launch";
let safeDetail = "";
const browser = await chromium.launch({
  headless: true,
  // The two peers share one isolated CI host. Expose its host candidates so
  // mDNS multicast support is not a hidden dependency of this loopback test.
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-webrtc-hide-local-ips-with-mdns"],
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
    stage = `browser-open-${i + 1}`;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    pages.push(page);
    await page.goto(roomUrl.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator("#connect-btn").waitFor({ state: "visible", timeout: 30_000 });
    // The button is present in static HTML before the async app initialization
    // attaches its handler. The generated peer capability is set only after
    // ZFA and dyncap are loaded and the Connect listener is installed.
    stage = `app-initialized-${i + 1}`;
    await page.waitForFunction(
      () => document.querySelector("#my-id")?.textContent?.startsWith("cap:peer:") ?? false,
      null,
      { timeout: 60_000 },
    );
  }
  const [a, b] = pages;
  // Distinguish these browser peers from the facilitator that the harness
  // starts in the same room. The roster assertion below uses the actual ids.
  await a.locator("#my-name").fill(nameA);
  await b.locator("#my-name").fill(nameB);
  const idA = (await a.locator("#my-id").innerText()).trim();
  const idB = (await b.locator("#my-id").innerText()).trim();

  stage = "connect-browser-1";
  await a.locator("#connect-btn").click();
  await a.waitForFunction(
    () => document.querySelector("#status-dot")?.classList.contains("connected") ?? false,
    null,
    { timeout: 30_000 },
  );
  stage = "connect-browser-2";
  await b.locator("#connect-btn").click();
  await b.waitForFunction(
    () => document.querySelector("#status-dot")?.classList.contains("connected") ?? false,
    null,
    { timeout: 30_000 },
  );
  check("both independent browser sessions connected to signaling", true);

  stage = "peer-roster-browser-1-sees-browser-2";
  await a.waitForFunction(
    (id) => [...document.querySelectorAll("#peer-list li")].some((li) => li.title === id),
    idB,
    { timeout: 30_000 },
  );
  stage = "peer-roster-browser-2-sees-browser-1";
  await b.waitForFunction(
    (id) => [...document.querySelectorAll("#peer-list li")].some((li) => li.title === id),
    idA,
    { timeout: 30_000 },
  );
  check("both browser sessions discovered the other room member", true);

  // /conn reports the actual RTCDataChannel state. A WebSocket roster entry
  // alone cannot satisfy this assertion.
  stage = "direct-webrtc-browser-1";
  const waitForDirectChannel = async (page, remoteName) => {
    await sendCommand(page, "/conn");
    try {
      await page.waitForFunction(
        (name) => new RegExp(`${name}\\s+channel open\\s+conn connected`, "i")
          .test(document.querySelector("#messages")?.innerText ?? ""),
        remoteName,
        { timeout: 30_000 },
      );
    } catch {
      const lines = await page.locator("#messages .msg").allTextContents();
      const states = lines.map((line) => {
        const m = /^\s*(\S+)\s+channel\s+(\S+)\s+conn\s+(\S+)\s+ice\s+(\S+)/i.exec(line);
        return m ? `${m[1]} channel=${m[2]} conn=${m[3]} ice=${m[4]}` : null;
      }).filter(Boolean);
      safeDetail = states.find((state) => state.startsWith(remoteName + " "))
        ?? states.at(-1) ?? "no /conn state row";
      throw new Error("direct WebRTC channel did not open");
    }
  };
  await waitForDirectChannel(a, nameB);
  stage = "direct-webrtc-browser-2";
  await waitForDirectChannel(b, nameA);
  check("both sides report an open direct WebRTC data channel", true);

  stage = "chat-relay";
  await sendCommand(a, marker);
  await waitForTranscript(b, marker, "browser-to-browser chat reached the second browser");

  stage = "goal-add";
  await sendCommand(a, `/goal add ${goal} | important`);
  await waitForTranscript(a, "🎯 added", "personal /goal add executed in the browser");
  stage = "goal-list";
  await sendCommand(a, "/goal list");
  await waitForTranscript(a, "personal goals (", "personal /goal list returned the stored goal");

  stage = "qos-start";
  await sendCommand(a, `/qos start ${processName}`);
  await waitForTranscript(a, `started **${processName}**`, "browser /qos start created a local signed process");
  stage = "qos-status";
  await sendCommand(a, `/qos status ${processName}`);
  await waitForTranscript(a, "events:", "browser /qos status reports process state and event count");
  stage = "qos-ps";
  await sendCommand(a, "/qos ps");
  await waitForTranscript(a, "QOS process table (", "browser /qos ps rendered the process table");

  console.log("QOS #601 browser acceptance: PASS");
  for (const item of checks) console.log(`PASS: ${item.label}`);
  console.log("Coverage: 2 Chromium contexts; signaling membership; direct WebRTC data channels; chat; /goal add+list; /qos start+status+ps.");
} catch (error) {
  // Playwright diagnostics can embed the full navigation URL, including the
  // bearer room capability. Redact them rather than risking a CI log leak.
  const kind = error instanceof Error ? error.name : "Error";
  console.error(`QOS #601 browser acceptance: FAIL at ${stage} (${kind}); ${safeDetail || "diagnostic details redacted"}.`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
