// room-names.test.mjs — room tab names, uniqueness, and the #/slug address.
//
//   node packages/browser/test/room-names.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `export * from "./src/room-names.ts";`,
    resolveDir: root,
    loader: "ts",
    sourcefile: "room-names-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const m = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

// slugify
ok("slug lowercases and dashes", m.slugify("  My   Design Room ") === "my-design-room");
ok("slug folds accents", m.slugify("Café Über") === "cafe-uber");
ok("slug drops punctuation edges", m.slugify("!!Q4 — plans!!") === "q4-plans", m.slugify("!!Q4 — plans!!"));
ok("slug of emoji-only is empty", m.slugify("🎉🎉") === "");

// checkRoomName
const names = new Map([["cap:room:1", "Design"], ["cap:room:2", "Design 2"]]);
let r = m.checkRoomName("  Strategy  ", names);
ok("valid name is normalized", r.ok && r.name === "Strategy" && r.slug === "strategy", JSON.stringify(r));
r = m.checkRoomName("", names);
ok("empty refused", !r.ok);
r = m.checkRoomName("🎉", names);
ok("no letters refused", !r.ok);
r = m.checkRoomName("cap:room:123", names);
ok("cap-looking refused", !r.ok);
r = m.checkRoomName("x".repeat(m.ROOM_NAME_MAX + 1), names);
ok("over-long refused", !r.ok);
r = m.checkRoomName("design", names);
ok("duplicate (case-insensitive) refused", !r.ok && /already exists/.test(r.error), JSON.stringify(r));
ok("duplicate suggests the next free number", !r.ok && r.suggestion === "design 3", JSON.stringify(r));
r = m.checkRoomName("DESIGN!", names);
ok("same slug counts as a duplicate", !r.ok);
r = m.checkRoomName("Design", names, "cap:room:1");
ok("a room may keep its own name", r.ok, JSON.stringify(r));
r = m.checkRoomName("Design 2", names);
ok("numbered duplicate suggests past the base", !r.ok && r.suggestion === "Design 3", JSON.stringify(r));
const sug = m.checkRoomName("Design", names).suggestion;
ok("suggestion is itself valid", m.checkRoomName(sug, names).ok);

// findRoomBySlug
ok("finds a room by slug", m.findRoomBySlug("design-2", names) === "cap:room:2");
ok("unknown slug is null", m.findRoomBySlug("nope", names) === null);

// hash round-trips
let h = m.parseRoomHash("#/my-room");
ok("slug-only hash", h.slug === "my-room" && h.params.get("room") === null);
h = m.parseRoomHash("#/my-room?name=My+Room&room=cap:room:0123");
ok("slug + params hash", h.slug === "my-room" && h.params.get("name") === "My Room" && h.params.get("room") === "cap:room:0123");
h = m.parseRoomHash("#room=cap:room:0123");
ok("legacy hash still parses", h.slug === null && h.params.get("room") === "cap:room:0123");
h = m.parseRoomHash("");
ok("empty hash", h.slug === null && [...h.params].length === 0);
const p = new URLSearchParams(); p.set("name", "My Room"); p.set("room", "cap:room:0123");
ok("build with slug", m.buildRoomHash("my-room", p) === "#/my-room?name=My+Room&room=cap:room:0123", m.buildRoomHash("my-room", p));
ok("build slug only", m.buildRoomHash("my-room", new URLSearchParams()) === "#/my-room");
ok("build nothing", m.buildRoomHash(null, new URLSearchParams()) === "");
ok("build legacy", m.buildRoomHash(null, new URLSearchParams("room=cap:room:1")) === "#room=cap:room:1");

// nameFromInvite
ok("invite carries name", m.nameFromInvite("https://x.io/q/#/my-room?name=My+Room&room=cap:room:1") === "My Room");
ok("legacy invite has no name", m.nameFromInvite("https://x.io/q/#room=cap:room:1") === null);
ok("bare cap has no name", m.nameFromInvite("cap:room:1") === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
