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

// --- a write is done only when it answers its own verb's success -----------
check("each verb's own answer is success", M.answerError("post", ["posted", NEWS, 3]) === null &&
  M.answerError("open", ["already", NEWS]) === null && M.answerError("subscribe", ["subscribed", NEWS, 0, 2]) === null);
check("a refusal is a failure", M.answerError("close", ["gov-error", "no such channel", NEWS])?.startsWith("no such channel"));
check("another verb's answer is a failure", M.answerError("allow", ["disallowed", NEWS, A]) !== null);
check("a failed deploy rendered as a value is a failure", M.answerError("post", M.firstValue(['{"deployError": "Out of phlo"}'])) !== null);
check("an answer that cannot be read is a failure", M.answerError("unsubscribe", null) !== null);

// --- a policy is open or invite, nothing else --------------------------------
check("no policy is open", M.policyFrom(undefined) === "open" && M.policyFrom("") === "open");
check("open and invite are taken as typed", M.policyFrom("open") === "open" && M.policyFrom("Invite") === "invite");
check("a typo is refused, not made public", M.policyFrom("invte") === null && M.policyFrom("private") === null);

// --- cursors are kept per node, shard and contract ---------------------------
const one = { node: "http://127.0.0.1:40403/", shard: "/root", contract: "rho:id:aaa" };
const two = { ...one, contract: "rho:id:bbb" };
const net = { ...one, node: "https://playground.rhobot.net" };
const book = {};
book[M.cursorKey(one, NEWS)] = 40;   // contract one has run to post 40
book[M.cursorKey(two, NEWS)] = 2;    // the same address/name in contract two is only at 2
check("the same channel id in two contracts keeps two cursors",
  M.cursorKey(one, NEWS) !== M.cursorKey(two, NEWS) && M.cursorsIn(book, two)[NEWS] === 2 && M.cursorsIn(book, one)[NEWS] === 40);
check("a cursor from one contract is not used in another it has never read",
  M.cursorsIn(book, net)[NEWS] === undefined);
check("a trailing slash on the node does not split a scope",
  M.cursorKey(one, NEWS) === M.cursorKey({ ...one, node: "http://127.0.0.1:40403" }, NEWS));

// --- every text survives the trip --------------------------------------------
const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("") + "\u007F\u0085\u2028\u2029";
for (const [label, t] of [["CRLF and tab", "a\r\nb\tc"], ["every control character", controls],
  ["quotes, backslashes, percents", 'q " b \\ p 100% %22 %u0041'], ["Unicode", "héllo 日本 🎉"],
  ["lone surrogates", "x \uD800 y \uDC00"]]) {
  const e = R.channelText.encode(t);
  check(`${label}: decoded exactly, sent with no backslash`, M.decodeText(e) === t && !JSON.stringify(e).includes("\\"), JSON.stringify(e));
}
check("a post stored by the earlier encoding still decodes", M.decodeText("say %22hi%22 %5C 100%25%0Aend") === 'say "hi" \\ 100%\nend');

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
