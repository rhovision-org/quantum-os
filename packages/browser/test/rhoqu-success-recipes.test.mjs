// rhoqu-success-recipes.test.mjs — the shipped RhoQu subset, exercised
// against the success-framework recipe library.
//
//   node packages/browser/test/rhoqu-success-recipes.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `
      export { transpile, RhoQuError } from "./src/rhoqu.ts";
      export { SUCCESS_RECIPES, recipeById } from "./src/success-recipes.ts";
    `,
    resolveDir: root,
    loader: "ts",
    sourcefile: "rhoqu-recipes-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { transpile, RhoQuError, SUCCESS_RECIPES, recipeById } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};
const ctx = (peers = 3) => {
  const handlers = [];
  return {
    handlers,
    value: {
      hasLemma: () => false,
      balance: () => 0,
      isCurrencyDeclared: () => false,
      peerCount: () => peers,
      isConnected: () => true,
      myCurrentSeq: () => 0,
      registerOnHandler: (h) => handlers.push(h),
    },
  };
};

// --- every recipe uses the shipped subset --------------------------------
ok("recipe library is non-empty", SUCCESS_RECIPES.length >= 6, String(SUCCESS_RECIPES.length));
ok("recipe ids are unique", new Set(SUCCESS_RECIPES.map((r) => r.id)).size === SUCCESS_RECIPES.length);
ok("no recipe uses the pipe operator", SUCCESS_RECIPES.every((r) => !r.source.includes("|")), SUCCESS_RECIPES.filter((r) => r.source.includes("|")).map((r) => r.id).join(","));

for (const recipe of SUCCESS_RECIPES) {
  const c = ctx(3);
  let cmds;
  try { cmds = transpile(recipe.source, c.value); }
  catch (e) { ok(`${recipe.id} transpiles`, false, e?.message ?? String(e)); continue; }
  ok(`${recipe.id} transpiles`, cmds.length > 0, JSON.stringify(cmds));
  ok(`${recipe.id} emits only /commands`, cmds.every((x) => x.startsWith("/")), JSON.stringify(cmds));
  ok(`${recipe.id} has a title and notes`, !!recipe.title && !!recipe.notes);
}

// --- personal prioritization ---------------------------------------------
const weekly = transpile(recipeById("weekly-prioritize").source, ctx(1).value);
ok("weekly prioritization adds the goal", weekly.some((c) => c === "/goal add Finish the success framework docs"), JSON.stringify(weekly));
ok("weekly prioritization reviews locally", weekly.includes("/goal review"));

// --- group retrospective + transpile-time branch -------------------------
const three = transpile(recipeById("retrospective").source, ctx(3).value);
ok("retrospective creates a group issue", three.some((c) => c === "/gov issue Retrospective this cycle"), JSON.stringify(three));
ok("retrospective asks feedback twice", three.filter((c) => c.startsWith("/channel send feedback")).length === 2);
ok("retrospective opens a poll with peers", three.some((c) => c === "/poll new Adopt the top improvement"));
ok("retrospective adds poll options without a pipe", three.includes("/poll add keep") && three.includes("/poll add change"));
const one = transpile(recipeById("retrospective").source, ctx(1).value);
ok("retrospective omits the poll below quorum", !one.some((c) => c.startsWith("/poll")), JSON.stringify(one));

// --- okr / listening / search / renewal ----------------------------------
const okr = transpile(recipeById("okr-checkin").source, ctx(1).value);
ok("okr check-in uses the objective", okr.some((c) => c === "/gov issue Check-in: Ship phase 1"), JSON.stringify(okr));
ok("okr check-in records a lemma", okr.includes("/lemma okr-checkin-recorded"));

const listen = transpile(recipeById("listening-round").source, ctx(1).value);
ok("listening round subscribes", listen.includes("/channel listen listening"));
ok("listening round tags the topic", listen.some((c) => c.includes("Round on the charter")));
ok("listening round invokes the chair", listen.includes("/facil chair"));

const search = transpile(recipeById("collective-search").source, ctx(1).value);
ok("collective search calls /search", search.includes("/search the next closure"));
ok("collective search records the query", search.some((c) => c.includes("Search: the next closure")));

const renewal = transpile(recipeById("renewal-check").source, ctx(1).value);
ok("renewal opens a poll", renewal.includes("/poll new What should we renew for next month?"));
ok("renewal includes a private review", renewal.includes("/goal review"));

// --- on handler -----------------------------------------------------------
const fc = ctx(1);
const loop = transpile(recipeById("feedback-loop").source, fc.value);
ok("feedback loop registers one handler", fc.handlers.length === 1, String(fc.handlers.length));
ok("feedback loop names the channel", fc.handlers[0]?.channel === "feedback", JSON.stringify(fc.handlers[0]));
ok("feedback loop binds the payload", fc.handlers[0]?.binding === "msg", JSON.stringify(fc.handlers[0]));
const triggered = fc.handlers[0]?.trigger("anything");
ok("handler trigger emits its body", Array.isArray(triggered) && triggered.includes("/lemma feedback-received"), JSON.stringify(triggered));
ok("feedback loop also sends a ready line", loop.some((c) => c.includes("Ready for feedback")));

// --- honest documentation of current limits ------------------------------
const parallel = transpile("parallel { /goal add A; /goal add B; }", ctx(1).value);
ok("parallel is sequential in source order", JSON.stringify(parallel) === JSON.stringify(["/goal add A", "/goal add B"]), JSON.stringify(parallel));

try {
  transpile("missing-process();", ctx(1).value);
  ok("unknown process is rejected", false, "did not throw");
} catch (e) {
  ok("unknown process is rejected", e instanceof RhoQuError, e?.message ?? String(e));
}

// A literal `$LAST_ID` is not bound by this runtime; it survives as text.
const lastId = transpile("/lemma $LAST_ID;", ctx(1).value);
ok("$LAST_ID is not silently bound", lastId[0] === "/lemma $LAST_ID", JSON.stringify(lastId));

try {
  transpile("/poll new Question | yes, no;", ctx(1).value);
  ok("a pipe inside a raw command is rejected/parsed as a separator", false, "did not throw");
} catch (e) {
  ok("a pipe inside a raw command is rejected/parsed as a separator", true);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: rhoqu-success-recipes.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
