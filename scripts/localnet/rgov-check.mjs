#!/usr/bin/env node
// rgov-check.mjs — does rgov's governance rholang still run, on THIS rnode?
//
// rgov (rhovision-org/rgov) is the governance app r-wallet's contract
// dropdown was ported from: ten contract classes in `rholang/core/`, and ~36
// action scripts that are CLIENTS of those classes. It was written against the
// Scala node. This asks what still works on rholo, so a redesign starts
// from evidence rather than from the 2021 shape.
//
// It exists because two node bugs that shaped rgov's design are now FIXED —
// rholo#19 (a one-binder persistent receive in a nested `new` never
// terminates) and #21 (a registry-looked-up facet answers only the first call
// per program), both closed 2026-08-29 and verified live. Code written to dodge
// them can be simplified, but only once we know what it is.
//
//   node scripts/localnet/rgov-check.mjs --node https://rnodeapi.rhobot.net
//
//   --node <url>    default http://127.0.0.1:40403
//   --rgov <dir>    a local rgov checkout; otherwise sources are fetched from
//                   GitHub and cached under .rgov-cache/ (gitignored)
//   --only <name>   run one case
//   --no-stub       do not stub the identity urns (see stubIdentity below)
//   --genesis       skip the bootstrap: use the genesis governance set
//   --verbose       print each program and rnode's raw answer
//
// TIER 2 — `--tier 2`, needs a funded key:
//
//   node scripts/localnet/rgov-check.mjs --tier 2 --node https://rnodeapi.rhobot.net
//
// Tier 1 can only ask whether a script parses and reduces. Tier 2 installs
// rgov's contract classes for real — signed deploys, phlo, blocks — and
// records the registry uri each one returns, which is what every client action
// needs before it can be run at all.
//
// It can do that remotely because of how rgov's classes are written: each one
// ends with `deployId!(["#define $Name", uri])`, so the uri comes back in the
// deploy's own result. rgov's own bootstrap instead greps the node's log for
// `ReadcapURI` (bootstrap/deploy-all), which only works on the machine running
// the node; the deployId path works from anywhere.
//
// Like macro-check.mjs, every case here is an EXPLORATORY deploy: unsigned,
// free, no block, nothing written. Same two consequences, and they are SKIPS
// rather than failures because neither is a defect in the script:
//
//   * `rho:rchain:deployerId` is unbound in an exploratory deploy, so any
//     script that identifies its caller cannot run here → `needs-deploy`.
//   * A `rho:registry:lookup` of a uri nothing has registered never answers,
//     and most rgov actions look up the master contract → `needs-bootstrap`.
//     Clearing those is Tier 2's job (deploy the classes first); this file is
//     Tier 1, which needs no bootstrap and answers the prior question: is
//     rgov's rholang alive at all.
//
// It reports; it does not triage. A failure gives the script, the call site and
// what rnode said. Whether that means a stale script, a node change or a wrong
// case is a separate problem from running the thing.

import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRawRgov, withArgs } from "../../packages/browser/src/rgov-apply.js";

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const NODE = arg("--node", "http://127.0.0.1:40403");
const RGOV_DIR = arg("--rgov", null);
const ONLY = arg("--only", null);
const VERBOSE = process.argv.includes("--verbose");
// Identity urns are stubbed to plain names by default so a script's logic can
// be reached unsigned (see stubIdentity). --no-stub reports them as skips
// instead, which is the stricter, less informative reading.
const STUB = !process.argv.includes("--no-stub");
const TIER = Number(arg("--tier", "1"));
const KEY_NAME = arg("--key-name", "alice");
const PHLO = Number(arg("--phlo", "5000000"));
// Both rhobot chains now carry the governance set at GENESIS, reachable at the
// port constant below — so there is nothing to install, no master directory to
// publish, and no MemberDirectory to coax into registering GetMe. `--genesis`
// skips straight to the client actions, which is the configuration that
// matters from here on.
const GENESIS_READCAP = "rho:id:wxc4mwdh7otq4fd6iuxt84inepssyz5tugojf7ao68dkh4ebbncy";
const GENESIS = process.argv.includes("--genesis");

const RAW = "https://raw.githubusercontent.com/rhovision-org/rgov/master/";
const CACHE = join(import.meta.dirname, ".rgov-cache");

/** rgov's sources, from a local checkout or GitHub (cached). Returns null when
 *  a path does not exist — a missing file is itself an audit finding
 *  (`actions/createInboxAndCastVote.rho` is referenced by the app but absent). */
async function source(path) {
  if (RGOV_DIR) {
    const p = join(RGOV_DIR, path);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  const cached = join(CACHE, path.replace(/[/]/g, "__"));
  if (existsSync(cached)) {
    const t = readFileSync(cached, "utf8");
    return t === "\0missing" ? null : t;
  }
  mkdirSync(CACHE, { recursive: true });
  const res = await fetch(RAW + path);
  const text = res.ok ? await res.text() : null;
  writeFileSync(cached, text ?? "\0missing");
  return text;
}

// The governance core, after dropping what isn't rgov: the teaching demos
// (towers, sequencialLooping), the smoke test (helloWorld) and the empty stub
// (createInboxandCastVote) are not here. `missing: true` records one we expect
// to be absent, so its absence is reported as a finding rather than a crash.
const ACTIONS = [
  ["newInbox", "src/actions/newinbox.rho"],
  ["peekInbox", "src/actions/peekInbox.rho"],
  ["receiveFromInbox", "src/actions/receiveFromInbox.rho"],
  ["claimWithInbox", "src/actions/claimWithInbox.rho"],
  ["newChat", "src/actions/newChat.rho"],
  ["sendChat", "src/actions/sendChat.rho"],
  ["readChat", "src/actions/readChat.rho"],
  ["newBallot", "src/actions/newBallot.rho"],
  ["castBallot", "src/actions/castBallot.rho"],
  ["newIssue", "src/actions/newIssue.rho"],
  ["addVoterToIssue", "src/actions/addVoterToIssue.rho"],
  ["addGroupToIssue", "src/actions/addGroupToIssue.rho"],
  ["castVote", "src/actions/castVote.rho"],
  ["displayVote", "src/actions/displayVote.rho"],
  ["delegateVote", "src/actions/delegateVote.rho"],
  ["tallyVotes", "src/actions/tallyVotes.rho"],
  ["share", "src/actions/share.rho"],
  ["sendMail", "src/actions/sendMail.rho"],
  ["newGroup", "src/actions/newGroup.rho"],
  ["joinGroup", "src/actions/joinGroup.rho"],
  ["addMember", "src/actions/addMember.rho"],
  ["newMemberDirectory", "src/actions/newMemberDirectory.rho"],
  ["getRoll", "src/actions/getRoll.rho"],
  ["checkRegistration", "src/actions/checkRegistration.rho"],
  ["peekKudos", "src/actions/peekKudos.rho"],
  ["awardKudos", "src/actions/awardKudos.rho"],
  ["makeMint", "src/actions/makeMint.rho"],
  ["lookupURI", "src/actions/lookupURI.rho"],
  ["createURI", "src/actions/createURI.rho"],
  // Referenced by src/actions.js but absent from the repo — a known finding.
  ["createInboxandCastVote", "src/actions/createInboxAndCastVote.rho", { expectMissing: true }],
  // In the repo but in no dropdown — do they still work, and are they wanted?
  ["tallyBallot (orphan)", "src/actions/tallyBallot.rho"],
  ["CallForHelp (orphan)", "src/actions/CallForHelp.rho"],
  ["wannainit (orphan)", "src/actions/wannainit.rho"],
];

const CLASSES = [
  ["Ballot", "rholang/core/Ballot.rho"],
  ["Chat", "rholang/core/Chat.rho"],
  ["CrowdFund", "rholang/core/CrowdFund.rho"],
  ["Directory", "rholang/core/Directory.rho"],
  ["Group", "rholang/core/Group.rho"],
  ["Inbox", "rholang/core/Inbox.rho"],
  ["Issue", "rholang/core/Issue.rho"],
  ["Kudos", "rholang/core/Kudos.rho"],
  ["RevIssuer", "rholang/core/RevIssuer.rho"],
  ["memberIdGovRev", "rholang/core/memberIdGovRev.rho"],
];

// Deployed AFTER the master directory, because they register themselves INTO
// it: MemberDirectory reads `@[*deployerId, "MasterContractAdmin"]` and does
// `MCAwrite!("GetMe", …)` / `MCAwrite!("SendThem", …)`. Deploy it with the core
// batch and that read never matches, so it blocks and `GetMe` is never written
// — which then blocks newInbox and every action behind it. rgov's own
// bootstrap/deploy-all has the same ordering: core, propose, directory, then
// `find ../rholang/feature`.
const FEATURES = [
  ["MemberDirectory", "rholang/feature/MemberDirectory.rho"],
];

async function explore(term) {
  const res = await fetch(NODE + "/api/explore-deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(term),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
  // rnode reports an error as a bare JSON string where success is an object —
  // including the runaway "reduction step budget exceeded", which a client
  // written for the success shape renders as an empty result.
  if (typeof j === "string") return { error: j.slice(0, 200) };
  return { values: (j.expr ?? []).map((e) => JSON.stringify(e).slice(0, 100)) };
}

/**
 * Turn the identity urns into ordinary new-bound names.
 *
 * `rho:rchain:deployerId` and `rho:rchain:deployId` only exist inside a signed
 * deploy, so unsigned they fail before the script's own logic is reached —
 * deployId with rnode's `BugFoundError: No value set for …`, which reads like a
 * broken script and is not one. Dropping the urn from the `new` leaves a plain
 * unforgeable name of the same arity, so the script parses and reduces and we
 * learn whether its LOGIC still works. What it cannot tell us is whether the
 * identity semantics are right — that needs Tier 2 and a signed deploy.
 *
 * `new x(`rho:rchain:deployId`), y in {` → `new x, y in {`
 */
const stubIdentity = (src) => src.replace(/\(\s*`rho:rchain:deploy(?:er)?Id`\s*\)/g, "");

/** Why a script cannot run in an exploratory deploy — a skip, not a failure. */
function blockedBy(src) {
  // A registry lookup of something nothing has registered simply never
  // answers, and no stub fixes that: the class has to exist. Tier 2's job.
  if (/rho:registry:lookup/.test(src)) return "needs-bootstrap (looks up a deployed class)";
  if (!STUB && /rho:rchain:deploy(?:er)?Id/.test(src)) return "needs-deploy (identity is unbound unsigned)";
  return null;
}

/** Code shaped only to dodge the two now-fixed node bugs — the category the
 *  whole audit exists to find, since it can be simplified away. */
function workaroundHints(src) {
  const hints = [];
  const oneBinder = [...src.matchAll(/contract\s+\w+\s*\(([^)]*)\)/g)]
    .map((m) => m[1].split(",").filter((s) => s.trim()).length);
  const padded = oneBinder.filter((n) => n === 2).length;
  if (padded) hints.push(`${padded} two-param contract(s) — check for #19 padding`);
  const lookups = (src.match(/rho:registry:lookup/g) ?? []).length;
  if (lookups > 1) hints.push(`${lookups} lookups — #21 splitting may be unwound`);
  return hints;
}

const status = { ok: "ok       ", fail: "FAIL     ", skip: "skipped  ", miss: "missing  " };
let pass = 0, fail = 0, skipped = 0, missing = 0;
const findings = [];


// ---------------------------------------------------------------------------
// Tier 2 — install the classes, and learn their uris
// ---------------------------------------------------------------------------

/** Poll the deploy's own status for the result it sent to `rho:rchain:deployId`.
 *  Externally tagged: ProcessedWithSuccess | ProcessedWithError | NotProcessed. */
async function deployResult(sig, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let j;
    try { j = await (await fetch(`${NODE}/api/v1/deploy-status/${sig}`)).json(); } catch { continue; }
    if (j?.ProcessedWithSuccess) return { ok: true, result: j.ProcessedWithSuccess.deployResult ?? [] };
    if (j?.ProcessedWithError) return { ok: false, error: JSON.stringify(j.ProcessedWithError.deployError ?? j.ProcessedWithError).slice(0, 240) };
  }
  return { ok: false, error: "still not processed after 60s" };
}

async function tier2() {
  const { DEFAULT_CONFIG, deployTerm, evalTerm } = await import("../qos-cli/rholang-client.mjs");
  const keyLine = readFileSync(join(import.meta.dirname, "pk.txt"), "utf8")
    .split("\n").find((l) => l.startsWith(`${KEY_NAME}=`));
  if (!keyLine) { console.error(`no ${KEY_NAME}= in scripts/localnet/pk.txt`); process.exit(2); }
  const cfg = { ...DEFAULT_CONFIG, url: NODE, key: keyLine.split("=")[1].trim(), phloLimit: PHLO };

  if (GENESIS) {
    const readcap = GENESIS_READCAP;
    console.log(`rgov-check (tier 2 — GENESIS governance, no bootstrap) — ${NODE}`);
    console.log(`acting as ${KEY_NAME}; readcap ${readcap}\n`);
    // Say what the chain actually carries before running anything against it:
    // the genesis set is not the same list as rgov's own class directory.
    const probe = await evalTerm({ ...cfg, url: NODE }, `
new rl(\`rho:registry:lookup\`), ch, all in {
  rl!(\`${readcap}\`, *ch) | for (r <- ch) { r!(*all) | for (@m <- all) { return!(m.keys().toList()) } }
}`).catch((e) => ({ values: [String(e?.message ?? e)] }));
    console.log(`directory: ${probe.values?.[0] ?? "(no answer)"}\n`);
    await runActions(cfg, readcap, {});
    return;
  }

  // A bootstrap is NOT idempotent and cannot be made so from here.
  // `@[*deployerId, "MasterContractAdmin"]!({read, write, grant})` is a linear
  // send, so a second run leaves a SECOND value on that one channel; every
  // consumer peeks it with `<<-` and binds an arbitrary one. Measured on this
  // chain: two values, comparing unequal — two live directory instances, with
  // MemberDirectory writing GetMe into one while the published ReadcapURI read
  // the other. Nothing errors; the system just wires itself to the wrong
  // directory.
  //
  // Draining the channel first is not available: rholang has no non-blocking
  // receive, so a speculative `for` that finds nothing lingers as a waiting
  // continuation and swallows the NEXT value — worse than the disease. The
  // channel is keyed by deployerId, so the sound move is a virgin identity per
  // bootstrap, and refusing to reuse one.
  const ledgerPath = join(CACHE, "bootstrapped.json");
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
  const dirty = ledger.find((e) => e.key === KEY_NAME && e.node === NODE);
  if (dirty && !process.argv.includes("--force")) {
    console.error(`${KEY_NAME} already bootstrapped this node on ${dirty.at}.`);
    console.error(`Re-using it would add a second MasterContractAdmin and silently split the directory.`);
    console.error(`Pick an unused identity: --key-name bob|carol|dave  (or --force to accept a split state).`);
    process.exit(2);
  }

  console.log(`rgov-check (tier 2 — installing classes) — ${NODE}`);
  console.log(`deploying as ${KEY_NAME}, phloLimit ${PHLO}\n`);

  const uris = {};
  let ok = 0, bad = 0;
  for (const [name, path] of CLASSES) {
    if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) continue;
    const label = name.padEnd(18);
    const src = await source(path);
    if (src === null) { console.log(`${status.miss}${label}${path}`); bad++; continue; }

    // Deployed as written — no stubbing. Tier 2 is the signed path, which is
    // where deployId/deployerId actually exist.
    const dep = await deployTerm(cfg, src, { waitAttempts: 0 }).catch((e) => ({ ok: false, message: String(e?.message ?? e) }));
    if (!dep.ok) { console.log(`${status.fail}${label}${String(dep.message).slice(0, 160)}`); bad++; continue; }

    const res = await deployResult(dep.sig);
    if (!res.ok) { console.log(`${status.fail}${label}${res.error}`); bad++; continue; }

    const blob = JSON.stringify(res.result);
    const uri = blob.match(/rho:id:[a-z0-9]+/)?.[0];
    const defined = blob.match(/#define \$(\w+)/)?.[1];
    if (uri) {
      uris[defined ?? name] = uri;
      console.log(`${status.ok}${label}${defined ? "$" + defined + " " : ""}${uri}`);
      ok++;
    } else if (!/deployId\s*!/.test(src)) {
      // It registers, but only ever tells the node's LOG. rgov's own bootstrap
      // greps `ReadcapURI` out of the log for exactly this reason — which means
      // the class can only be installed by someone sitting on the node. Adding
      // one `deployId!(uri)` would make it installable by anyone; that is a
      // redesign note, not a failure to run.
      console.log(`${status.fail}${label}installed, but reports its uri only to stdout — unrecoverable off-node`);
      findings.push({ kind: "class", name, verdict: "log-only-uri" });
      bad++;
    } else {
      // It has a `deployId!(uri)` and still returned nothing, so something
      // stopped it before that send. Reported, not diagnosed.
      console.log(`${status.fail}${label}deployed; its deployId!(uri) never fired  ${blob.slice(0, 80)}`);
      findings.push({ kind: "class", name, verdict: "silent" });
      bad++;
    }
  }

  const out = join(CACHE, "classes.json");
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(out, JSON.stringify({ node: NODE, at: new Date().toISOString(), uris }, null, 2));
  console.log(`\n${ok} installed, ${bad} failed — uris written to ${out}`);
  if (!uris.Directory) {
    console.log("\nno Directory class — the master directory needs it, stopping here.");
    process.exit(1);
  }

  // --- 2b: the master contract directory ---------------------------------
  //
  // A port of bootstrap/master-contract-directory, which is a bash script that
  // greps the deploy log for `["#define $Name", uri]` lines and generates this
  // program. We already hold those uris, so we generate it directly.
  //
  // Faithful except for one thing: the original ends with a join
  // `for (final_X <- ret_X; … ; last <- lastUri)` whose `lastUri` is declared
  // and never written, so that join can never fire and its "Finished with…"
  // lines can never print. Reproducing dead code would only add noise, so it
  // is left out — and recorded here as a finding about the original.
  console.log("\n— master contract directory —");
  const names = Object.keys(uris);
  const entries = names.map((n) => `
         | lookup!(URI_${n}, *lookCh_${n})
         | for (C_${n} <- lookCh_${n}) {
            stdout!(["writing class to dictionary: ${n}", URI_${n}, *C_${n}])
            | @write!("${n}", *C_${n}, *ret_${n})
         }`).join("");
  const directoryProgram = `match [${names.map((n) => "`" + uris[n] + "`").join(", ")}] {[${names.map((n) => "URI_" + n).join(", ")}] => {
new
   lookup(\`rho:registry:lookup\`)
   ,deployerId(\`rho:rchain:deployerId\`)
   ,deployId(\`rho:rchain:deployId\`)
   ,stdout(\`rho:io:stdout\`)
   ,insertArbitrary(\`rho:registry:insertArbitrary\`)
   ,lookCh ,insertCh ,caps
${names.map((n) => `   ,lookCh_${n} ,ret_${n}`).join("\n")}
in {
   lookup!(URI_Directory, *lookCh)
   | for (Dir <- lookCh) {
      Dir!(*caps)
      | for (@{"read": read, "write": write, "grant": grant} <- caps) {
         @[*deployerId, "MasterContractAdmin"]!({"read": read, "write": write, "grant": grant})
         | insertArbitrary!(read, *insertCh)
         | for (URI <- insertCh) {
            stdout!({ "ReadcapURI": *URI})
            | deployId!({ "ReadcapURI": *URI })
         }${entries}
      }
   }
}
}}`;
  if (VERBOSE) console.log(directoryProgram);

  const dirDep = await deployTerm(cfg, directoryProgram, { waitAttempts: 0 }).catch((e) => ({ ok: false, message: String(e?.message ?? e) }));
  if (!dirDep.ok) { console.log(`${status.fail}directory        ${String(dirDep.message).slice(0, 200)}`); process.exit(1); }
  const dirRes = await deployResult(dirDep.sig);
  if (!dirRes.ok) { console.log(`${status.fail}directory        ${dirRes.error}`); process.exit(1); }
  const readcap = JSON.stringify(dirRes.result).match(/rho:id:[a-z0-9]+/)?.[0];
  if (!readcap) {
    console.log(`${status.fail}directory        deployed, but no ReadcapURI came back  ${JSON.stringify(dirRes.result).slice(0, 160)}`);
    process.exit(1);
  }
  console.log(`${status.ok}directory        ReadcapURI ${readcap}`);
  writeFileSync(join(CACHE, "directory.json"), JSON.stringify({ node: NODE, at: new Date().toISOString(), key: KEY_NAME, readcap, uris }, null, 2));
  ledger.push({ key: KEY_NAME, node: NODE, at: new Date().toISOString(), readcap });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  // --- 2c: the features, which register themselves into the directory ----
  console.log("\n— features (after the directory, they write into it) —");
  for (const [name, path] of FEATURES) {
    if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) continue;
    const label = name.padEnd(18);
    const src = await source(path);
    if (src === null) { console.log(`${status.miss}${label}${path}`); continue; }
    const dep = await deployTerm({ ...cfg, phloLimit: Math.max(PHLO, 8_000_000) }, src, { waitAttempts: 0 }).catch((e) => ({ ok: false, message: String(e?.message ?? e) }));
    if (!dep.ok) { console.log(`${status.fail}${label}${String(dep.message).slice(0, 160)}`); bad++; continue; }
    const r = await deployResult(dep.sig);
    // It reports nothing to deployId, so "processed without error" is all we
    // can see here. Whether it really wrote GetMe is proven by newInbox below.
    if (!r.ok) { console.log(`${status.fail}${label}${r.error.slice(0, 160)}`); bad++; continue; }
    console.log(`${status.ok}${label}processed — newInbox is the proof it registered GetMe`);
    ok++;
  }

  await runActions(cfg, readcap, uris);
}

/** The client actions, as signed deploys, with real scenario arguments. */
async function runActions(cfg, readcap, uris) {
  const { deployTerm } = await import("../qos-cli/rholang-client.mjs");
  let aOk = 0, aBad = 0;
  // --- claim an identity, then run the client actions --------------------
  //
  // Every action is run as a signed deploy, as one identity, with the default
  // arguments its own `match [...]` header carries and `$masterURI` replaced by
  // the ReadcapURI just published. newInbox goes first because it is what
  // populates `@[*deployerId, lockerTag]`, which the rest read.
  console.log("\n— governance actions (signed, as " + KEY_NAME + ") —");
  // A SCENARIO, not defaults. The files ship with placeholders ("$issue",
  // `$delegate`, "?") that no harness ever filled, so running them as written
  // means every inner receive waits for an object nobody created — which
  // reads as "blocked" and teaches nothing. These are real values, and the
  // order below exists so a thing is created before it is referenced.
  const scenario = {
    lockerTag: "inbox",
    // newGroup creates it; addMember/addGroupToIssue then name it.
    name: "audit-group",
    group: "audit-group",
    issue: "audit-issue",
    proposals: '"keep","drop"',
    theVote: "keep",
    choices: '"keep"',
    ballot: "audit-ballot",
    channel: "audit-chat",
    message: "hello from rgov-check",
    type: "chat",
    subtype: "",
    from: "bob", to: "carol", sub: "audit", body: "audit message",
    revAddress: "1111bRUvDCJ2ZtDMtCYU1ScW19uTRbVd9VHUmtPunMEQzS4oSxEkY", // carol
    // Filled from the chain below: the claimant's own inbox uri, and a real
    // registered class uri for lookupURI.
    toInboxURI: "", delegateURI: "", themBoxReg: "", URI: uris.Directory ?? "",
    userid: "bob", value: "42",
  };
  const order = ["newInbox", "newGroup", "joinGroup", "addMember", "newMemberDirectory",
    "getRoll", "checkRegistration", "newChat", "sendChat", "readChat", "peekInbox",
    "receiveFromInbox", "newBallot", "castBallot", "newIssue", "addVoterToIssue",
    "addGroupToIssue", "castVote", "displayVote", "delegateVote", "tallyVotes",
    "share", "sendMail", "peekKudos", "awardKudos", "makeMint", "lookupURI", "createURI"];
  const byName = new Map(ACTIONS.map(([n, p2]) => [n, p2]));
  const ordered = order.filter((n) => byName.has(n)).map((n) => [n, byName.get(n)]);
  for (const [name, path] of ordered) {
    if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) continue;
    const label = name.padEnd(20);
    const src = await source(path);
    if (src === null) { console.log(`${status.miss}${label}${path}`); continue; }
    // The claimant's own inbox uri, once newInbox has run — it is what the
    // "send it to a member" actions need as a destination.
    if (name === "newInbox" && !scenario.toInboxURI) { /* filled after the run below */ }
    const subbed = withArgs(src.replace(/\$masterURI/g, readcap), { ...scenario, ReadcapURI: readcap });
    if (subbed.error) { console.log(`${status.fail}${label}${subbed.error}`); aBad++; continue; }
    if (subbed.headerArity !== null && subbed.headerArity !== subbed.patternArity) {
      // The file cannot work at any argument values: its match subject and its
      // pattern are different lengths, so the case never fires.
      console.log(`${status.fail}${label}ARITY MISMATCH — header supplies ${subbed.headerArity}, pattern binds ${subbed.patternArity} (${subbed.names.join(", ")})`);
      aBad++;
      continue;
    }
    if (subbed.missing.length) console.log(`         ${name}: no scenario value for ${subbed.missing.join(", ")}`);
    const program = applyRawRgov(subbed.program);
    const dep = await deployTerm(cfg, program, { waitAttempts: 0 }).catch((e) => ({ ok: false, message: String(e?.message ?? e) }));
    if (!dep.ok) { console.log(`${status.fail}${label}${String(dep.message).slice(0, 140)}`); aBad++; continue; }
    const r = await deployResult(dep.sig);
    if (!r.ok) { console.log(`${status.fail}${label}${r.error.slice(0, 140)}`); aBad++; continue; }
    const blob = JSON.stringify(r.result);
    if (r.result.length === 0) {
      // Landed and said nothing. For these actions that means it blocked —
      // a `for` that never received — rather than that it did its job.
      console.log(`${status.fail}${label}no answer (blocked before its deployId!)`);
      aBad++;
    } else {
      console.log(`${status.ok}${label}${blob.slice(0, 110)}`);
      if (name === "newInbox") {
        const u = blob.match(/rho:id:[a-z0-9]+/)?.[0];
        if (u) { scenario.toInboxURI = u; scenario.delegateURI = u; scenario.themBoxReg = u;
                 console.log(`         (claimant inbox uri ${u} — used for toInboxURI/delegateURI/themBoxReg)`); }
      }
      aOk++;
    }
  }
  console.log(`\nactions: ${aOk} answered, ${aBad} did not`);
  process.exit(aBad === 0 ? 0 : 1);
}

if (TIER === 2) await tier2();

console.log(`rgov-check (tier 1 — no bootstrap${STUB ? ", identity stubbed" : ""}) — ${NODE}\n`);
try {
  const s = await (await fetch(NODE + "/api/status")).json();
  console.log(`rnode ${s.version?.node ?? "?"} · shard ${s.shardId} · height ${s.latestBlockNumber} · devMode ${s.devMode}\n`);
} catch {
  console.error(`cannot reach ${NODE} — is rnode running? (bash scripts/localnet/run-node.sh)`);
  process.exit(2);
}

async function run(kind, name, path, opts = {}) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  const label = name.padEnd(24);
  const src = await source(path);

  if (src === null) {
    const expected = opts.expectMissing ? " (referenced by src/actions.js — known)" : "";
    console.log(`${status.miss}${label}${path}${expected}`);
    findings.push({ kind, name, verdict: "missing", detail: path });
    missing++;
    return;
  }

  const hints = workaroundHints(src);
  const blocked = blockedBy(src);
  if (blocked) {
    console.log(`${status.skip}${label}${blocked}`);
    if (hints.length && VERBOSE) console.log(`         ${hints.join(" · ")}`);
    findings.push({ kind, name, verdict: "skipped", detail: blocked, hints });
    skipped++;
    return;
  }

  const program = applyRawRgov(STUB ? stubIdentity(src) : src);
  const r = await explore(program);
  if (VERBOSE) console.log(`\n--- ${name}\n${program}\n--- answer: ${JSON.stringify(r)}\n`);

  if (r.error) {
    console.log(`${status.fail}${label}${r.error}`);
    findings.push({ kind, name, verdict: "broken", detail: r.error, hints });
    fail++;
    return;
  }
  console.log(`${status.ok}${label}${r.values.length} value(s)${hints.length ? "  · " + hints.join(" · ") : ""}`);
  findings.push({ kind, name, verdict: "works", detail: `${r.values.length} values`, hints });
  pass++;
}

console.log("— contract classes —");
for (const [name, path] of CLASSES) await run("class", name, path);

console.log("\n— governance actions —");
for (const [name, path, opts] of ACTIONS) await run("action", name, path, opts);

console.log(`\n${pass} ran, ${fail} broken, ${skipped} skipped, ${missing} missing`);
const workarounds = findings.filter((f) => f.hints?.length);
if (workarounds.length) {
  console.log(`\n${workarounds.length} carry possible #19/#21 workarounds (both bugs are fixed — these can likely be simplified):`);
  for (const w of workarounds) console.log(`  ${w.name.padEnd(24)}${w.hints.join(" · ")}`);
}
console.log("\ntier 2 installs the classes: --tier 2 --node <url> (needs a funded key from pk.txt).");
process.exit(fail === 0 ? 0 : 1);
