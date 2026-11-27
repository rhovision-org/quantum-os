// chat-view.test.mjs — the room transcript a joiner is handed, time marks,
// and mentions of known names.
//
//   node packages/browser/test/chat-view.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `export * from "./src/chat-view.ts";`,
    resolveDir: root, loader: "ts", sourcefile: "chat-view-test-entry.ts",
  },
  bundle: true, format: "esm", platform: "node", write: false,
});
const cv = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

const T0 = new Date(2026, 10, 25, 14, 5, 10).getTime();
const min = 60_000;

// --- sanitize -------------------------------------------------------------
const clean = cv.sanitizeTranscript([
  { from: "b", text: "second", at: T0 + 2 * min },
  { from: "a", text: "first", at: T0 },
  { from: "", text: "no author", at: T0 },
  { from: "c", text: "", at: T0 },
  { from: "c", text: "no time" },
  { from: "c", text: "future", at: T0 + 999 * min },
  "junk", null,
], T0 + 10 * min);
ok("sanitize keeps well-formed lines, sorted by time", clean.map((l) => l.text).join(",") === "first,second,future", JSON.stringify(clean));
ok("sanitize pulls a future time back to now", clean[2].at === T0 + 10 * min);
ok("sanitize of a non-array is empty", cv.sanitizeTranscript({ lines: [] }, T0).length === 0);

// --- transcriptForSync ----------------------------------------------------
const many = Array.from({ length: 50 }, (_, i) => ({ from: "a", text: `line ${i}`, at: T0 + i }));
const tail = cv.transcriptForSync(many, 10);
ok("sync takes the newest lines, oldest first", tail.length === 10 && tail[0].text === "line 40" && tail[9].text === "line 49");
const byBytes = cv.transcriptForSync(many, 1000, 200);
ok("sync stays under the byte budget", JSON.stringify(byBytes).length <= 200 && byBytes.at(-1).text === "line 49", String(JSON.stringify(byBytes).length));

// --- merge ----------------------------------------------------------------
const make = (l) => ({ from: l.from, text: l.text, at: l.at, chat: true, via: "x" });
const log = [
  { from: "a", text: "hi", at: T0, chat: true },
  { from: "", text: "hello", at: T0 + 2 * min, chat: true },        // ours
  { from: "", text: "a card", poll: true },                          // no time
  { from: "b", text: "late", at: T0 + 5 * min, chat: true },
];
const r = cv.mergeTranscript(log, [
  { from: "a", text: "hi", at: T0 + 3_000 },                // same line, another peer's clock
  { from: "me", text: "hello", at: T0 + 2 * min + 500 },    // ours, relayed under our id
  { from: "c", text: "missed", at: T0 + 3 * min },
  { from: "c", text: "earliest", at: T0 - min },
], make, "me");
ok("merge adds only the lines not already held", r.added === 2, String(r.added));
ok("merge places lines by time, cards keep their place",
  r.log.map((l) => l.text).join("|") === "earliest|hi|hello|a card|missed|late", r.log.map((l) => l.text).join("|"));
ok("merge leaves the input log untouched", log.length === 4);
const again = cv.mergeTranscript(r.log, [{ from: "c", text: "missed", at: T0 + 3 * min + 1000 }], make, "me");
ok("merging the same transcript twice adds nothing", again.added === 0);
const repeat = cv.mergeTranscript(r.log, [{ from: "c", text: "missed", at: T0 + 30 * min }], make, "me");
ok("the same words much later are a new line", repeat.added === 1);

// --- time marks -----------------------------------------------------------
ok("first line gets a mark", cv.needsTimeMark(T0, null));
ok("same minute gets no mark", !cv.needsTimeMark(T0 + 30_000, T0));
ok("next minute gets a mark", cv.needsTimeMark(T0 + 55_000, T0));
ok("mark today shows the time only", !cv.timeMarkText(T0, null, T0 + min).includes("·"));
ok("mark after a day change shows the date", cv.timeMarkText(T0 + 24 * 60 * min, T0, T0 + 24 * 60 * min).includes("·"));
ok("first mark on an older day shows the date", cv.timeMarkText(T0, null, T0 + 3 * 24 * 60 * min).includes("·"));

// --- mentions -------------------------------------------------------------
const names = ["Jim", "Jim Whitescarver", "Al", "Claude"];
const words = (text) => cv.findMentions(text, names).map((m) => text.slice(m.start, m.end));
ok("bare and @ mentions found", words("hey jim, ask @Claude").join(",") === "jim,@Claude", words("hey jim, ask @Claude").join(","));
ok("longest name wins", words("thanks Jim Whitescarver!").join(",") === "Jim Whitescarver");
ok("whole words only", words("Jimmy and Claudette").length === 0);
ok("a two-letter name needs @", words("Al said hi to @al").join(",") === "@al");
ok("names report how they are spelled", cv.findMentions("JIM", names)[0]?.name === "Jim");
ok("no names, no mentions", cv.findMentions("Jim", []).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
