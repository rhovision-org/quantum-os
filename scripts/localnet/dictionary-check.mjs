#!/usr/bin/env node
// dictionary-check.mjs — the redesigned master dictionary, against a live chain.
//
// Design and measurements: ../../MasterDictionary.md. This is the evidence the
// genesis proposal travels with, so it tests the claims that matter and the ones
// that must FAIL: publishing outside your own root, writing with a revoked
// writekey, publishing to a sealed path, and setting a short name without the
// root authority.
//
// Needs a funded key and a node, so not in CI.
//
//   node scripts/localnet/dictionary-check.mjs [--node <url>]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as D from "../../packages/browser/src/dictionary.js";
import { DEFAULT_CONFIG, deployTerm, revAddressOf } from "../qos-cli/rholang-client.mjs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
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
  if (!r.ok) { fail++; console.log(`FAIL ${label}: ${String(r.message).slice(0, 160)}`); return null; }
  for (let i = 0; i < 16; i++) {
    await sleep(4000);
    let j; try { j = await (await fetch(`${NODE}/api/v1/deploy-status/${r.sig}`)).json(); } catch { continue; }
    if (j?.ProcessedWithError) { fail++; console.log(`FAIL ${label}: ${JSON.stringify(j.ProcessedWithError.deployError ?? j.ProcessedWithError).slice(0, 200)}`); return null; }
    if (j?.ProcessedWithSuccess) {
      const v = (j.ProcessedWithSuccess.deployResult ?? []).map(unwrap);
      const okc = check ? check(JSON.stringify(v)) : v.length > 0;
      if (okc) pass++; else fail++;
      console.log(`${okc ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(v).slice(0, 190)}`);
      return JSON.stringify(v);
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
  const okc = check ? check(JSON.stringify(v)) : v.length > 0;
  if (okc) pass++; else fail++;
  console.log(`${okc ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(v).slice(0, 190)}`);
  return JSON.stringify(v);
}

console.log(`dictionary-check — ${NODE}\nalice ${A}\nbob   ${B}\n`);
const out = await write("install (alice is root authority)", alice, D.installProgram(), (v) => v.includes("rho:id:"));
const URI = (out ?? "").match(/rho:id:[a-z0-9]+/)?.[0];
if (!URI) { console.log("no uri — stopping"); process.exit(1); }
console.log(`  uri ${URI}\n`);

const AP = `${A}/inbox`, BP = `${B}/inbox`;

// ── publishing is self-service, and rooted ──────────────────────────────────
await write("alice publishes under her own root", alice,
  D.publishProgram(URI, AP, `{"v": 1}`), (v) => v.includes("published") && v.includes('"0"') === false && v.includes("0"));
await write("alice publishes v2 — append-only", alice,
  D.publishProgram(URI, AP, `{"v": 2}`), (v) => v.includes("published") && v.includes("1"));
await read("resolve gives the latest", D.resolveProgram(URI, AP), (v) => v.includes('"v":2'));
await read("resolveAt(0) still gives the first — immutable", D.resolveAtProgram(URI, AP, 0), (v) => v.includes('"v":1'));
await read("versionsOf", D.versionsOfProgram(URI, AP), (v) => v.includes("2"));
await read("ownerOf is the publisher", D.ownerOfProgram(URI, AP), (v) => v.includes(A));

// THE claim: squatting is not expressible.
await write("BOB CANNOT publish under alice's root", bob,
  D.publishProgram(URI, AP, `{"stolen": true}`), (v) => v.includes("not your namespace"));
await write("bob publishes under his own root", bob,
  D.publishProgram(URI, BP, `{"bob": 1}`), (v) => v.includes("published"));
await read("alice's path is untouched", D.resolveProgram(URI, AP), (v) => v.includes('"v":2') && !v.includes("stolen"));

// ── grant, and revoke ───────────────────────────────────────────────────────
// A granted writekey is an unforgeable, so it is used in the term that obtained
// it — the same constraint rgov-core documents. Grant, use, revoke, use again.
const viaPublish = (inner) => `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`),
    deployId(\`rho:rchain:deployId\`), stored, capsCh, ret, r2, r3 in {
  lookup!(\`${URI}\`, *stored) |
  for (@record <- stored) {
    match record { (_, c) => { capsCh!(c) } c => { capsCh!(c) } } |
    for (@caps <- capsCh) {
      match caps { {"publish": found, ..._} => { ${inner} } _ => { deployId!("no facet") } }
    }
  }
}`;
await write("a granted writekey publishes to its one path", alice,
  viaPublish(`@found!(*deployerId, "grant", [${JSON.stringify(AP)}], *ret) |
        for (@answer <- ret) {
          match answer {
            ("granted", _, _, wk) => { @wk!({"viaGrant": true}, *r2) | for (@x <- r2) { deployId!(["used", x]) } }
            _ => { deployId!(["unexpected", answer]) }
          }
        }`),
  (v) => v.includes("used") && v.includes("published"));
await write("revoke bumps the epoch", alice, D.revokeProgram(URI, AP), (v) => v.includes("revoked"));
await write("a writekey granted BEFORE the revoke is dead", alice,
  viaPublish(`@found!(*deployerId, "grant", [${JSON.stringify(AP)}], *ret) |
        for (@answer <- ret) {
          match answer {
            ("granted", _, _, wk) => {
              @found!(*deployerId, "revoke", [${JSON.stringify(AP)}], *r3) |
              for (@_rev <- r3) { @wk!({"afterRevoke": true}, *r2) | for (@x <- r2) { deployId!(["used", x]) } }
            }
            _ => { deployId!(["unexpected", answer]) }
          }
        }`),
  (v) => v.includes("revoked"));

// ── seal ────────────────────────────────────────────────────────────────────
await write("alice seals her path", alice, D.sealProgram(URI, AP), (v) => v.includes("sealed"));
await write("a sealed path refuses further versions", alice,
  D.publishProgram(URI, AP, `{"v": 99}`), (v) => v.includes("sealed"));
await read("…and still resolves", D.resolveProgram(URI, AP), (v) => v.includes("viaGrant") || v.includes('"v":2'));

// ── short names are governed, and are aliases ───────────────────────────────
await write("BOB cannot set a short name", bob,
  D.aliasProgram(URI, "Inbox", BP), (v) => v.includes("not the root authority"));
await write("the root authority aliases Inbox -> alice's path", alice,
  D.aliasProgram(URI, "Inbox", AP), (v) => v.includes("aliased"));
await read("a short name resolves to the value", D.resolveProgram(URI, "Inbox"),
  (v) => v.includes("viaGrant") || v.includes('"v":2'));
await read("aliases lists it", D.aliasesProgram(URI), (v) => v.includes("Inbox"));
// The upgrade story: re-point the alias, clients unchanged.
await write("re-point Inbox -> bob's path (an upgrade)", alice,
  D.aliasProgram(URI, "Inbox", BP), (v) => v.includes("aliased"));
await read("the SAME short name now resolves elsewhere", D.resolveProgram(URI, "Inbox"),
  (v) => v.includes('"bob":1'));
await read("the rooted path is unaffected by the alias", D.resolveProgram(URI, BP), (v) => v.includes('"bob":1'));

// ── discovery, and the error discipline ─────────────────────────────────────
await read("list by prefix", D.listProgram(URI, `${A}/`), (v) => v.includes(AP) && !v.includes(BP));
await read("a wrong arity ANSWERS", D.readProgram(URI, "resolve", []), (v) => v.includes("bad verb or arity"));
await read("an unknown verb ANSWERS", D.readProgram(URI, "nope", ['"x"']), (v) => v.includes("bad verb or arity"));
await read("resolving an unknown name is Nil, not an error", D.resolveProgram(URI, "no/such/path"), (v) => v === "[]" || v.includes("null"));

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
