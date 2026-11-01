#!/usr/bin/env node
// channel-check.mjs — install the Channel contract (rgov-core.js §4,
// quantum-os#78) on a live chain and walk publish/subscribe through it.
//
// The offline half is `node packages/browser/src/rgov-core.js --selftest`. This
// is the half that needs a node: that the rholang parses, that posts land and
// page, and that what must be refused is refused — bob posting to alice's
// channel, bob reading an invite channel he was not allowed into, a post after
// close. Not in CI: it needs funded keys and a chain.
//
//   node scripts/localnet/channel-check.mjs [--node <url>]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "../../packages/browser/src/rgov-core.js";
import { DEFAULT_CONFIG, deployTerm, revAddressOf } from "../qos-cli/rholang-client.mjs";

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const NODE = arg("--node", "https://rnodeapi.rhobot.net");
const pk = readFileSync(join(import.meta.dirname, "pk.txt"), "utf8");
const keyOf = (n) => pk.split("\n").find((l) => l.startsWith(`${n}=`))?.split("=")[1].trim();
const alice = keyOf("alice"), bob = keyOf("bob");
const A = revAddressOf(alice), B = revAddressOf(bob);
const cfg = (k) => ({ ...DEFAULT_CONFIG, url: NODE, key: k, phloLimit: 8_000_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;

const unwrap = (n) => {
  if (n === null || typeof n !== "object") return n;
  const [tag, payload] = Object.entries(n)[0];
  const body = payload && typeof payload === "object" && "data" in payload && Object.keys(payload).length === 1 ? payload.data : payload;
  switch (tag) {
    case "ExprPar": case "ExprTuple": case "ExprList": case "ExprSet": return body.map(unwrap);
    case "ExprMap": return Object.fromEntries((Array.isArray(body) ? body : Object.entries(body)).map(([k, v]) => [k, unwrap(v)]));
    case "ExprUnforg": return "<unforgeable>";
    default: return body;
  }
};

async function write(label, key, program, check) {
  const r = await deployTerm(cfg(key), program, { waitAttempts: 0 });
  if (!r.ok) { fail++; console.log(`FAIL ${label}: submit — ${String(r.message).slice(0, 180)}`); return null; }
  for (let i = 0; i < 16; i++) {
    await sleep(4000);
    let j; try { j = await (await fetch(`${NODE}/api/v1/deploy-status/${r.sig}`)).json(); } catch { continue; }
    if (j?.ProcessedWithError) { fail++; console.log(`FAIL ${label}: ${JSON.stringify(j.ProcessedWithError.deployError ?? j.ProcessedWithError).slice(0, 220)}`); return null; }
    if (j?.ProcessedWithSuccess) {
      const v = (j.ProcessedWithSuccess.deployResult ?? []).map(unwrap);
      const okc = check ? check(v) : v.length > 0;
      if (okc) pass++; else fail++;
      console.log(`${okc ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(v).slice(0, 200)}`);
      return v;
    }
  }
  fail++; console.log(`FAIL ${label}: not processed`); return null;
}

// Read at the NEWEST block. Plain /api/explore-deploy evaluates against the last
// FINALIZED block, which trails a write by a block or more, so a read right after
// a write saw the state from before it — 16 of rgov-core-check's and 5 of
// dictionary-check's failures on rholo bc80abb were exactly that.
async function exploreLatest(program) {
  const blocks = await (await fetch(`${NODE}/api/blocks/1`)).json().catch(() => []);
  const blockHash = blocks?.[0]?.blockHash;
  if (!blockHash) return fetch(`${NODE}/api/explore-deploy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(program) });
  return fetch(`${NODE}/api/explore-deploy-by-block-hash`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ term: program, blockHash, usePreStateHash: false }) });
}

async function read(label, program, check) {
  const res = await exploreLatest(program);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { fail++; console.log(`FAIL ${label}: ${text.slice(0, 160)}`); return null; }
  if (typeof j === "string") { fail++; console.log(`FAIL ${label}: ${j.slice(0, 200)}`); return null; }
  const v = (j.expr ?? []).map(unwrap);
  const okc = check ? check(v) : v.length > 0;
  if (okc) pass++; else fail++;
  console.log(`${okc ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(v).slice(0, 220)}`);
  return v;
}

const uriOf = (v) => JSON.stringify(v ?? "").match(/rho:id:[a-z0-9]+/)?.[0];
const has = (s) => (v) => JSON.stringify(v).includes(s);

console.log(`channel check — ${NODE}\nalice ${A}\nbob   ${B}\n`);

const CH = uriOf(await write("install Channel", alice, C.installChannelProgram()));
console.log(`  Channel ${CH}\n`);
if (!CH) { console.log("install failed — stopping"); process.exit(1); }
const NEWS = C.channelIdOf(A, "news"), DESK = C.channelIdOf(A, "desk");

// ── an open channel ──────────────────────────────────────────────────────────
await write("alice opens news (open)", alice, C.channelOpenProgram(CH, "news", "open"), has("opened"));
await write("alice opens news again (idempotent)", alice, C.channelOpenProgram(CH, "news", "open"), has("already"));
await write("a bad policy is refused", alice, C.channelOpenProgram(CH, "x", "public"), has("policy is open or invite"));
await write("alice posts #1", alice, C.channelPostProgram(CH, "news", "first"), has(`"posted","${NEWS}",1`));
await write("bob subscribes from now", bob, C.channelSubscribeProgram(CH, NEWS, "now"), has(`"subscribed","${NEWS}",1,1`));
await write("alice posts #2", alice, C.channelPostProgram(CH, "news", "second"), has(`"posted","${NEWS}",2`));
await write("alice posts #3 with quotes", alice, C.channelPostProgram(CH, "news", 'say "hi"'), has(`"posted","${NEWS}",3`));
// bob's "news" is under bob's own address, not alice's: there is no way to name hers.
await write("bob posting to news reaches only his own (absent) channel", bob, C.channelPostProgram(CH, "news", "spam"),
  has(`"no such channel","${C.channelIdOf(B, "news")}"`));
await write("bob reads from his subscription: #2 and #3, not #1", bob, C.channelReadProgram(CH, NEWS),
  (v) => { const s = JSON.stringify(v); return s.includes("second") && s.includes("say %22hi%22") && !s.includes("first"); });
await read("anyone reads an open channel free, from the start", C.channelPostsProgram(CH, NEWS), (v) => JSON.stringify(v).includes("first"));
await read("paging: one post after #1", C.channelPostsProgram(CH, NEWS, 1, 1),
  (v) => { const s = JSON.stringify(v); return s.includes("second") && !s.includes("first") && !s.includes("say"); });
await read("info: open, 3 posts, 1 subscriber", C.channelInfoProgram(CH, NEWS),
  (v) => { const s = JSON.stringify(v); return s.includes('"seq":3') && s.includes('"subscribers":1') && s.includes('"closed":false'); });
await read("info lists no subscriber address", C.channelInfoProgram(CH, NEWS), (v) => !JSON.stringify(v).includes(B));
await write("bob unsubscribes", bob, C.channelUnsubscribeProgram(CH, NEWS), has("unsubscribed"));
await read("info: 0 subscribers", C.channelInfoProgram(CH, NEWS), has('"subscribers":0'));

// ── close: withdrawn, not erased ─────────────────────────────────────────────
await write("alice closes news", alice, C.channelCloseProgram(CH, "news"), has("closed"));
await write("a post after close is refused", alice, C.channelPostProgram(CH, "news", "late"), has(`"closed","${NEWS}"`));
await read("posts survive the close, and say so", C.channelPostsProgram(CH, NEWS),
  (v) => { const s = JSON.stringify(v); return s.includes("first") && s.includes(",true,3]"); });

// ── an invite channel ────────────────────────────────────────────────────────
await write("alice opens desk (invite)", alice, C.channelOpenProgram(CH, "desk", "invite"), has("opened"));
await write("alice posts to desk", alice, C.channelPostProgram(CH, "desk", "memo"), has("posted"));
await read("the free read refuses an invite channel", C.channelPostsProgram(CH, DESK), has("invite-only channel"));
await write("bob cannot subscribe uninvited", bob, C.channelSubscribeProgram(CH, DESK, "head"), has("invite-only channel"));
await write("bob cannot read uninvited", bob, C.channelReadProgram(CH, DESK), has("not allowed"));
await write("alice allows bob", alice, C.channelAllowProgram(CH, "desk", B), has("allowed"));
await write("bob subscribes from head", bob, C.channelSubscribeProgram(CH, DESK, "head"), has(`"subscribed","${DESK}",0,1`));
await write("bob reads the memo", bob, C.channelReadProgram(CH, DESK), has("memo"));
await write("alice disallows bob", alice, C.channelDisallowProgram(CH, "desk", B), has("disallowed"));
await write("bob's read is refused again", bob, C.channelReadProgram(CH, DESK), has("not allowed"));
await write("alice still reads her own", alice, C.channelReadProgram(CH, DESK), has("memo"));
await read("channelsOf alice", C.channelsOfProgram(CH, A), (v) => { const s = JSON.stringify(v); return s.includes("news") && s.includes("desk"); });
await write("a bad arity answers", alice, C.writeProgram(CH, "self", "post", ['"news"']), has("bad verb or arity"));

// ── retention: the oldest post goes once a channel passes its cap ────────────
// The same contract with the cap at 2 instead of CHANNEL_KEEP, so the trim runs
// in three posts rather than five hundred.
const small = C.installChannelProgram().replace(`length() > ${C.CHANNEL_KEEP}`, "length() > 2");
const CH2 = uriOf(await write("install a Channel capped at 2", alice, small));
if (CH2) {
  const T = C.channelIdOf(A, "t");
  await write("open t", alice, C.channelOpenProgram(CH2, "t", "open"), has("opened"));
  for (const n of [1, 2, 3]) await write(`post t #${n}`, alice, C.channelPostProgram(CH2, "t", `p${n}`), has(`"posted","${T}",${n}`));
  await read("the oldest is dropped, the newest two kept", C.channelPostsProgram(CH2, T),
    (v) => { const s = JSON.stringify(v); return !s.includes('"p1"') && s.includes('"p2"') && s.includes('"p3"'); });
  await read("info: seq 3, kept 2", C.channelInfoProgram(CH2, T), (v) => { const s = JSON.stringify(v); return s.includes('"seq":3') && s.includes('"kept":2'); });
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
