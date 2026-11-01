// chain-channel.test.mjs — reading the Channel contract's answers (quantum-os#78).
//
// chain-channel.ts is dependency-free, so it bundles and imports cleanly. The
// answers below are what renderExpr made of real ones from a localnet run of
// scripts/localnet/channel-check.mjs.
//
//   node packages/browser/test/chain-channel.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "chain-channel.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const M = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const R = await import("../src/rgov-core.js");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

const A = "1111bn92xHbttqWHEXqD8PiykFxgeUjizzquT6JRePj2pAoHFAuiK";
const NEWS = `${A}/news`;

// --- parseRendered ---------------------------------------------------------
check("a tuple becomes a list, Nil becomes null",
  JSON.stringify(M.parseRendered('("posts", "a/b", [], Nil, false, 0)')) === '["posts","a/b",[],null,false,0]');
check("parens and Nil inside a string are left alone",
  JSON.stringify(M.parseRendered('("x", "(Nil) here")')) === '["x","(Nil) here"]');
check("a name that starts with Nil is not Nil", M.parseRendered('"Nilsson"') === "Nilsson");
check("an unforgeable is unparseable, and says so with null", M.parseRendered("Unforgeable(…)") === null);

// --- postsOf ---------------------------------------------------------------
const page = M.postsOf(M.firstValue([`("posts", "${NEWS}", [{"seq": 2, "text": "second"}, {"seq": 3, "text": "say %22hi%22"}], 3, false, 3)`]));
check("a page reads back", !("error" in page) && page.posts.length === 2 && page.next === 3 && page.newest === 3 && page.closed === false,
  JSON.stringify(page));
check("text is decoded", page.posts?.[1]?.text === 'say "hi"', JSON.stringify(page.posts));
const empty = M.postsOf(M.parseRendered(`("posts", "${NEWS}", [], 2, true, 2)`));
check("an empty page keeps the cursor and says closed", !("error" in empty) && empty.next === 2 && empty.closed === true);
const refused = M.postsOf(M.parseRendered(`("gov-error", "invite-only channel", "${A}/desk")`));
check("a refusal is an error line", "error" in refused && refused.error.startsWith("invite-only channel"), JSON.stringify(refused));

// --- infoOf ----------------------------------------------------------------
const info = M.infoOf(M.parseRendered(`("info", {"closed": false, "id": "${NEWS}", "kept": 2, "name": "news", "owner": "${A}", "policy": "open", "seq": 2, "subscribers": 1})`));
check("info reads back", !("error" in info) && info.policy === "open" && info.seq === 2 && info.subscribers === 1, JSON.stringify(info));

// --- naming ----------------------------------------------------------------
check("address/name is anybody's", M.channelIdFrom(NEWS) === NEWS);
check("a bare name is your own", M.channelIdFrom("news", A) === NEWS);
check("a bare name with no key names nothing", M.channelIdFrom("news") === null);
check("a non-address prefix is refused", M.channelIdFrom("bob/news", A) === null);
check("a name is one word, no slash", M.validName("news") && !M.validName("a b") && !M.validName("a/b") && !M.validName(""));
check("your own channel is labelled yours", M.channelLabel(NEWS, A) === "news (yours)");

// --- the two halves agree --------------------------------------------------
const odd = 'quote " back \\ pct % nl\nend';
check("the browser decodes what rgov-core encodes", M.decodeText(R.channelText.encode(odd)) === odd);
check("channelIdOf and channelIdFrom agree", R.channelIdOf(A, "news") === M.channelIdFrom("news", A));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
