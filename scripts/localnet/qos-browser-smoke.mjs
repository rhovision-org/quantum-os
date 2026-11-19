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
const peerDiagnostics = [];
const redactPeerCaps = (text) => text
  .replace(/cap:(?:peer|room):[A-Za-z0-9_-]+/g, "[capability]")
  .replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?(?:#[^\s]*)?/g, "[url]");
function safeTranscript(page) {
  return page.locator("#messages .msg").allTextContents()
    .then((lines) => lines.slice(-30).map((line) => redactPeerCaps(line).slice(0, 500)));
}

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
  // Enter is owned by the command-palette completion handler while a
  // suggestion is active. Click the real Send button to exercise send().
  await page.locator("#send-btn").click();
}

try {
  for (let i = 0; i < 2; i++) {
    stage = `browser-open-${i + 1}`;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    pages.push(page);
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[qos-peer]")) peerDiagnostics.push(redactPeerCaps(text));
    });
    page.on("pageerror", (error) => peerDiagnostics.push(redactPeerCaps(`pageerror: ${error.name}`)));
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
  // The visible roster is name-oriented. Distinct names let this test
  // prove that the two browser sessions see each other, not just the facilitator.
  stage = "peer-roster-browser-1-sees-browser-2";
  await a.waitForFunction(
    (name) => [...document.querySelectorAll("#peer-list li")]
      .some((li) => li.textContent?.trim() === name),
    nameB,
    { timeout: 30_000 },
  );
  stage = "peer-roster-browser-2-sees-browser-1";
  await b.waitForFunction(
    (name) => [...document.querySelectorAll("#peer-list li")]
      .some((li) => li.textContent?.trim() === name),
    nameA,
    { timeout: 30_000 },
  );
  check("both browser sessions discovered the other room member", true);

  // /conn reports the actual RTCDataChannel state. A WebSocket roster entry
  // alone cannot satisfy this assertion.
  stage = "direct-webrtc-browser-1";
  const waitForDirectChannel = async (page, remoteName) => {
    await sendCommand(page, "/conn connect " + remoteName);
    await waitForTranscript(page, "direct connection requested to " + remoteName,
      "browser requested a direct connection to " + remoteName);

    // /conn is a snapshot, not a live view. Re-run it while ICE/SCTP negotiates;
    // waiting on the first rendered row only observes the pre-handshake state
    // forever, even if the data channel opens a moment later.
    const deadline = Date.now() + 30_000;
    let connected = false;
    while (Date.now() < deadline) {
      await sendCommand(page, "/conn");
      try {
        await page.waitForFunction(
          (name) => [...document.querySelectorAll("#messages .msg")].some((node) => {
            const line = node.textContent?.trim() ?? "";
            return line.startsWith(name + " ")
              && /\bchannel\s+open\s+conn\s+connected\b/i.test(line);
          }),
          remoteName,
          { timeout: Math.min(1_000, Math.max(1, deadline - Date.now())) },
        );
        connected = true;
        break;
      } catch {
        if (Date.now() < deadline) await page.waitForTimeout(250);
      }
    }
    if (connected) return;

    const lines = await page.locator("#messages .msg").allTextContents();
    const states = lines.map((line) => {
      const m = /^\s*(\S+)\s+channel\s+(\S+)\s+conn\s+(\S+)\s+ice\s+(\S+)/i.exec(line);
      return m ? `${m[1]} channel=${m[2]} conn=${m[3]} ice=${m[4]}` : null;
    }).filter(Boolean);
    safeDetail = states.find((state) => state.startsWith(remoteName + " "))
      ?? states.at(-1) ?? "no /conn state row";
    throw new Error("direct WebRTC channel did not open");
  };
  await waitForDirectChannel(a, nameB);
  stage = "direct-webrtc-browser-2";
  await waitForDirectChannel(b, nameA);
  check("both sides report an open direct WebRTC data channel", true);

  stage = "chat-relay";
  await sendCommand(a, marker);
  await waitForTranscript(b, marker, "browser-to-browser chat reached the second browser");

  // Exercise the public Rholo HTTP API from the browser command surface. This
  // remains read-only: status and eval, no signing key and no deploy.
  stage = "rholang-node-config";
  await sendCommand(a, "/rholang rnode http://127.0.0.1:40403");
  await waitForTranscript(a, "✓ rnode set to http://127.0.0.1:40403", "browser configured the disposable Rholo node");
  stage = "rholang-status";
  await sendCommand(a, "/rholang status");
  await waitForTranscript(a, "✓ rnode", "browser /rholang status returned node version", 20_000);
  stage = "rholang-eval";
  await sendCommand(a, "/rholang eval return!(42)");
  await waitForTranscript(a, "→ 42", "browser /rholang eval returned the expected read-only value", 30_000);

  stage = "goal-add";
  await sendCommand(a, `/goal add ${goal} | important`);
  await waitForTranscript(a, "🎯 added", "personal /goal add executed in the browser");
  stage = "goal-list";
  await sendCommand(a, "/goal list");
  await waitForTranscript(a, "personal goals (", "personal /goal list returned the stored goal");
  stage = "goal-identity-isolation";
  await sendCommand(b, "/goal list");
  await waitForTranscript(b, "no personal goals yet", "second browser identity cannot see the first browser's private goal");
  const addedLine = (await a.locator("#messages .msg").allTextContents())
    .find((line) => line.includes(goal) && line.includes("🎯 added"));
  const goalId = addedLine?.match(/added\s+(g-\d+)\s+—/)?.[1];
  if (!goalId) throw new Error("could not identify the newly added personal goal");
  stage = "goal-done";
  await sendCommand(a, `/goal done ${goalId}`);
  await waitForTranscript(a, `${goalId} done — ${goal}`, "personal /goal done marks the goal completed");
  stage = "goal-share";
  await sendCommand(a, `/goal share ${goalId}`);
  await waitForTranscript(a, `→ shared ${goalId}`, "owner explicitly shared one goal into the room");
  await waitForTranscript(b, `shared goal: ${goal}`, "second browser received the explicitly shared goal");

  stage = "qos-start";
  await sendCommand(a, `/qos start ${processName}`);
  // Surface the command's own error instead of turning every failed start into
  // an opaque Playwright timeout. The expected success message remains required.
  await a.waitForFunction(
    (name) => {
      const transcript = document.querySelector("#messages")?.innerText ?? "";
      return transcript.includes(`started ${name}`) || transcript.includes("⚠ /qos:");
    },
    processName,
    { timeout: 20_000 },
  );
  const qosStartText = await a.locator("#messages").innerText();
  if (!qosStartText.includes(`started ${processName}`)) {
    safeDetail = qosStartText.split("\n").slice(-12)
      .map((line) => redactPeerCaps(line).replace(/\b[0-9a-f]{64}\b/gi, "[hash]").slice(0, 220))
      .join(" | ");
    throw new Error("QOS process start returned an application error");
  }
  check("browser /qos start created a local signed process", true);
  stage = "qos-status";
  await sendCommand(a, `/qos status ${processName}`);
  await waitForTranscript(a, "events:", "browser /qos status reports process state and event count");
  stage = "qos-ps";
  await sendCommand(a, "/qos ps");
  await waitForTranscript(a, "QOS process table (", "browser /qos ps rendered the process table");

  console.log("QOS #601 browser acceptance: PASS");
  for (const item of checks) console.log(`PASS: ${item.label}`);
  console.log("Coverage: 2 Chromium contexts; signaling membership; direct WebRTC data channels; chat; /rholang status+eval; /goal add+list+done, identity privacy, explicit share; /qos start+status+ps.");
} catch (error) {
  // Playwright diagnostics can embed the full navigation URL, including the
  // bearer room capability. Redact them rather than risking a CI log leak.
  const kind = error instanceof Error ? error.name : "Error";
  console.error(`QOS #601 browser acceptance: FAIL at ${stage} (${kind}); ${safeDetail || "diagnostic details redacted"}.`);
  for (const [index, page] of pages.entries()) {
    try {
      const lines = await safeTranscript(page);
      for (const line of lines) console.error(`TRANSCRIPT_${index + 1}: ${line}`);
    } catch { /* page may already be closed */ }
  }
  for (const line of peerDiagnostics.slice(-30)) console.error(`PEER_DIAG: ${line}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
