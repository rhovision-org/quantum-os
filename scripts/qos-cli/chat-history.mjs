// chat-history.mjs — the room's conversation as an agent hands it to a joiner.
//
// The browser's join handshake carries a `sync-chat` of the chat lines a peer
// saw (packages/browser/src/chat-view.ts). An agent sends the same kind, so a
// joiner gets the history an agent heard before any browser now present was
// there — and, with --persist, history from before the agent's own restart,
// read back from the room memory's transcript.jsonl.
//
//   node chat-history.mjs --selftest

import fs from "node:fs";

export const SYNC_CHAT_MAX_LINES = 300;
export const SYNC_CHAT_MAX_BYTES = 120_000;   // the relay's frame cap is 256 KB
const LINE_MAX = 8_000;

/** The newest lines that fit one envelope, oldest first (mirrors chat-view.ts transcriptForSync). */
export function historyForSync(lines, maxLines = SYNC_CHAT_MAX_LINES, maxBytes = SYNC_CHAT_MAX_BYTES) {
  const out = [];
  let bytes = 2;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const l = lines[i];
    if (!l || typeof l.text !== "string" || !l.text || l.text.length > LINE_MAX) continue;
    const size = JSON.stringify(l).length + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    out.push(l);
  }
  return out.reverse();
}

/**
 * The chat lines in a room memory's transcript.jsonl (one `{t, from, msg}` per
 * line), newest `max`, with each author's name taken from the `name`
 * envelopes in the same file. Reads only the file's tail, so a long-lived
 * room's transcript does not have to fit in memory. Missing file → [].
 */
export function loadPersistedChat(file, max = SYNC_CHAT_MAX_LINES, tailBytes = 4 * 1024 * 1024) {
  let text;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);   // drop the cut first line
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const names = new Map();
  const out = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    const m = rec?.msg;
    if (!m || typeof m !== "object" || typeof rec.from !== "string") continue;
    if (m.kind === "name" && typeof m.name === "string" && m.name.trim()) { names.set(rec.from, m.name.trim()); continue; }
    if (m.kind !== "chat" || typeof m.text !== "string" || !m.text || m.text.length > LINE_MAX) continue;
    const at = Date.parse(rec.t);
    if (!Number.isFinite(at)) continue;
    out.push({ from: rec.from, label: undefined, text: m.text, at });
  }
  for (const l of out) l.label = names.get(l.from);
  return out.slice(-max);
}

// ---------------------------------------------------------------------------
if (process.argv.includes("--selftest")) {
  const os = await import("node:os");
  const path = await import("node:path");
  let pass = 0, fail = 0;
  const ok = (label, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
  };

  const many = Array.from({ length: 50 }, (_, i) => ({ from: "a", text: `line ${i}`, at: i + 1 }));
  const tail = historyForSync(many, 10);
  ok("newest lines, oldest first", tail.length === 10 && tail[0].text === "line 40" && tail[9].text === "line 49");
  ok("byte budget respected", JSON.stringify(historyForSync(many, 1000, 200)).length <= 200);
  ok("empty and oversize lines skipped", historyForSync([{ from: "a", text: "", at: 1 }, { from: "a", text: "x".repeat(9000), at: 2 }]).length === 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-"));
  const file = path.join(dir, "transcript.jsonl");
  const rec = (t, from, msg) => JSON.stringify({ t: new Date(t).toISOString(), from, msg });
  fs.writeFileSync(file, [
    rec(1000, "cap:peer:aa", { kind: "name", name: "Ann" }),
    rec(2000, "cap:peer:aa", { kind: "chat", text: "hello" }),
    rec(3000, "cap:peer:bb", { kind: "qlf", cmd: "zfa", lines: [] }),
    "not json",
    rec(4000, "cap:peer:bb", { kind: "chat", text: "hi Ann" }),
  ].join("\n") + "\n");
  const got = loadPersistedChat(file);
  ok("chat lines only, in order", got.map((l) => l.text).join("|") === "hello|hi Ann", JSON.stringify(got));
  ok("names from the transcript", got[0].label === "Ann" && got[1].label === undefined);
  ok("times kept", got[0].at === 2000 && got[1].at === 4000);
  ok("newest max", loadPersistedChat(file, 1).map((l) => l.text).join() === "hi Ann");
  ok("tail read drops the cut line", loadPersistedChat(file, 300, 60).every((l) => l.text === "hi Ann"));
  ok("missing file → []", loadPersistedChat(path.join(dir, "nope.jsonl")).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
