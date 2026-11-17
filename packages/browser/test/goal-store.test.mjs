// goal-store.test.mjs — private personal goals, identity-scoped.
//
//   node packages/browser/test/goal-store.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `
      export { GoalStore, parseGoalAdd, GOAL_PRIORITIES } from "./src/goal-store.ts";
    `,
    resolveDir: root,
    loader: "ts",
    sourcefile: "goal-store-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { GoalStore, parseGoalAdd, GOAL_PRIORITIES } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

class MemoryStorage {
  map = new Map();
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

const alice = "cap:peer/dyn:alice";
const bob = "cap:peer/dyn:bob";
const storage = new MemoryStorage();
let now = 1000;
const a = new GoalStore(storage, alice, () => now++);

// --- add / list / persistence ---------------------------------------------
const g1 = a.add("Ship the success framework docs", "important");
ok("add returns an open goal", g1.status === "open" && g1.priority === "important", JSON.stringify(g1));
ok("first id is deterministic", g1.id === "g-1", g1.id);
ok("list is a copy", a.list().length === 1 && a.list()[0] !== a.list()[0], "identity comparison");
a.list()[0].text = "mutated outside";
ok("mutating the snapshot does not mutate the store", a.list()[0].text === "Ship the success framework docs");

const a2 = new GoalStore(storage, alice, () => 2000);
ok("same identity reloads goals", a2.list().length === 1 && a2.list()[0].text === "Ship the success framework docs");
ok("next id survives reload", a2.add("Second goal").id === "g-2");

// --- identity scoping ------------------------------------------------------
const b = new GoalStore(storage, bob, () => 3000);
ok("a different identity sees no goals", b.list().length === 0);
b.add("Bob's private goal");
ok("Bob only sees his goal", b.list().length === 1 && b.list()[0].text === "Bob's private goal");
ok("Alice still sees only hers", a2.list().length === 2 && a2.list().every((g) => g.text !== "Bob's private goal"));

// --- complete / review / remove -------------------------------------------
const done = a2.complete("g-1");
ok("complete marks done and stamps time", done?.status === "done" && typeof done.completedAt === "number", JSON.stringify(done));
ok("unknown goal is null", a2.complete("g-999") === null);
const review = a2.review();
ok("review splits open and done", review.open.length === 1 && review.done.length === 1, JSON.stringify({o:review.open.length,d:review.done.length}));
ok("remove works", a2.remove("g-2") === true && a2.list().length === 1);
ok("removing an unknown goal is false", a2.remove("g-2") === false);

// --- share snapshot --------------------------------------------------------
const shared = a2.share("g-1");
ok("share returns only the shareable fields", shared && shared.text === "Ship the success framework docs" && !("createdAt" in shared), JSON.stringify(shared));
ok("sharing an unknown goal is null", a2.share("g-999") === null);

// --- parsing ---------------------------------------------------------------
const p1 = parseGoalAdd("Write the charter | urgent-important");
ok("parse add with priority", p1?.text === "Write the charter" && p1.priority === "urgent-important", JSON.stringify(p1));
const p2 = parseGoalAdd("Write the charter");
ok("parse add defaults to important", p2?.priority === "important");
const p3 = parseGoalAdd("Write the charter | both");
ok("both aliases urgent-important", p3?.priority === "urgent-important");
ok("empty text is rejected", parseGoalAdd("   ") === null);
ok("priority set is finite", GOAL_PRIORITIES.join(",") === "urgent-important,important,urgent,neither");

// --- corrupt storage -------------------------------------------------------
const corrupt = new MemoryStorage();
corrupt.setItem(GoalStore.keyFor(alice), "{not json");
const c = new GoalStore(corrupt, alice);
ok("corrupt storage starts empty instead of throwing", c.list().length === 0);
const wrongVersion = new MemoryStorage();
wrongVersion.setItem(GoalStore.keyFor(alice), JSON.stringify({ v: 99, goals: [{ id: "g-1", text: "x", priority: "important", status: "open", createdAt: 1 }] }));
ok("unknown schema version is ignored", new GoalStore(wrongVersion, alice).list().length === 0);

// --- storage refusal is non-fatal -----------------------------------------
const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
const r = new GoalStore(refusing, alice);
r.add("still works in memory");
ok("storage refusal keeps the in-memory list", r.list().length === 1);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: goal-store.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
