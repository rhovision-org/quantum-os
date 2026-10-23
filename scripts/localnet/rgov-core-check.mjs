#!/usr/bin/env node
// rgov-core-check.mjs — install the three contracts on a live chain and walk a
// scenario through them, ending in the four `rho:gov:*` natives.
//
// The companion to `node packages/browser/src/rgov-core.js --selftest`, which
// checks the half that ships (every source well-formed, every call site
// correct) with no node. This checks the half that cannot be checked offline:
// that the rholang parses, that state lands where it should, that privilege is
// refused where it should be, and — the point of the whole design — that what a
// `read` verb answers is what the native it feeds actually takes.
//
// Not in CI: it needs a funded key and a chain. Run it after touching
// rgov-core.js.
//
//   node scripts/localnet/rgov-core-check.mjs [--node <url>] [--key-name alice]
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

/**
 * A hand-written program that reaches a contract's `self` facet, for the cases
 * the call-site builders cannot express.
 *
 * A GRANTED CAPABILITY CANNOT BE CARRIED ACROSS DEPLOYS BY A CLIENT. What
 * `grantRead`, `grantSend` and `enroll` hand back is an unforgeable name, and
 * there is no source syntax for one — it comes back in the deploy result as a
 * hex string that no later program can turn into a name again. So a capability
 * is either used in the same term that obtained it, or DELIVERED into the Inbox
 * and bound out of a message by whoever receives it. That is not a limitation
 * to route around: it is precisely why the inbox is a capability vault and why
 * its contents are privileged. Both paths are exercised below.
 *
 * `inner` may use `found` (the facet), `deployerId`, `ret` and `deployId`.
 */
const viaSelf = (uri, inner) => `new lookup(\`rho:registry:lookup\`),
    deployerId(\`rho:rchain:deployerId\`), deployId(\`rho:rchain:deployId\`),
    stored, ret, ret2, r2 in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    new capsCh in {
      match record { (_, c) => { capsCh!(c) } c => { capsCh!(c) } } |
      for (@caps <- capsCh) {
        match caps {
          {"self": found, ..._} => { ${inner} }
          _ => { deployId!(("gov-error", "no self facet")) }
        }
      }
    }
  }
}`;

console.log(`rgov-core check — ${NODE}\nalice ${A}\nbob   ${B}\n`);

// ── install ──────────────────────────────────────────────────────────────────
const iv = await write("install Inbox", alice, C.installInboxProgram());
const gv = await write("install Group", alice, C.installGroupProgram());
const sv = await write("install Issue", alice, C.installIssueProgram());
const INBOX = uriOf(iv), GROUP = uriOf(gv), ISSUE = uriOf(sv);
console.log(`  Inbox ${INBOX}\n  Group ${GROUP}\n  Issue ${ISSUE}\n`);
if (!INBOX || !GROUP || !ISSUE) { console.log("install failed — stopping"); process.exit(1); }

// ── Inbox ────────────────────────────────────────────────────────────────────
await write("inbox: alice creates a locker", alice, C.newLockerProgram(INBOX, "inbox", "open"),
  (v) => JSON.stringify(v).includes("created"));
await write("inbox: alice creates it again (idempotent)", alice, C.newLockerProgram(INBOX, "inbox", "open"),
  (v) => JSON.stringify(v).includes("already"));
await write("inbox: bob sends alice a message", bob,
  C.sendProgram(INBOX, A, "inbox", `{"type": "greeting", "body": "hello"}`),
  (v) => JSON.stringify(v).includes("sent"));
await read("inbox: read facet answers types, not bodies", C.readProgram(INBOX, "typesIn", [JSON.stringify(A), '"inbox"']),
  (v) => JSON.stringify(v).includes("greeting"));
await read("inbox: read facet answers a count", C.countInProgram(INBOX, A, "inbox", "greeting"),
  (v) => v[0] === 1);
await read("inbox: read facet has NO verb for a body", C.readProgram(INBOX, "peek", [JSON.stringify(A), '"inbox"']),
  (v) => JSON.stringify(v).includes("bad verb or arity"));
await write("inbox: alice receives, and 'from' is bob", alice, C.receiveProgram(INBOX, "inbox"),
  (v) => JSON.stringify(v).includes(B) && JSON.stringify(v).includes("hello"));
await read("inbox: the locker is now empty", C.countInProgram(INBOX, A, "inbox", "greeting"),
  (v) => v[0] === 0);

// ── Group ────────────────────────────────────────────────────────────────────
await write("group: alice creates g1", alice, C.createGroupProgram(GROUP, "g1", "Test Group", "open"),
  (v) => JSON.stringify(v).includes("created"));
await write("group: bob joins", bob, C.joinGroupProgram(GROUP, "g1", "Bob"),
  (v) => JSON.stringify(v).includes("joined"));
await write("group: bob CANNOT set a role (not an admin)", bob,
  C.writeProgram(GROUP, "self", "setRole", ['"g1"', JSON.stringify(B), '"admin"']),
  (v) => JSON.stringify(v).includes("not an admin"));
await write("group: alice rates bob 3", alice, C.rateProgram(GROUP, "g1", B, 3),
  (v) => JSON.stringify(v).includes("rated"));
await write("group: bob delegates to alice", bob, C.delegateProgram(GROUP, "g1", A, null),
  (v) => JSON.stringify(v).includes("delegated"));
await write("group: a wrong arity ANSWERS instead of falling silent", alice,
  C.writeProgram(GROUP, "self", "rate", ['"g1"']),
  (v) => JSON.stringify(v).includes("bad verb or arity"));

const ratings = await read("group: ratingsOf -> trustLevels arg 1", C.ratingsOfProgram(GROUP, "g1"),
  (v) => Array.isArray(v[0]) && v[0].length === 1 && v[0][0][2] === 3);
const admins = await read("group: adminsOf -> trustLevels arg 2", C.adminsOfProgram(GROUP, "g1"),
  (v) => Array.isArray(v[0]) && v[0][0] === A);
await read("group: delegationsOf -> resolveWeights arg 2", C.delegationsOfProgram(GROUP, "g1", null),
  (v) => v[0] && v[0][B] === A);
await read("group: vouchersOf == ratingsOf", C.vouchersOfProgram(GROUP, "g1"),
  (v) => JSON.stringify(v) === JSON.stringify(ratings));

// ── Issue ────────────────────────────────────────────────────────────────────
await write("issue: alice opens i1", alice,
  C.openIssueProgram(ISSUE, "i1", "g1", "Ship it?", "approval", ["yes", "no"], [A, B]),
  (v) => JSON.stringify(v).includes("opened"));
await write("issue: bob casts a ballot", bob, C.castProgram(ISSUE, "i1", ["yes"]),
  (v) => JSON.stringify(v).includes("cast"));
const ballots = await read("issue: ballotsOf -> tally arg 1", C.ballotsOfProgram(ISSUE, "i1"),
  (v) => v[0] && Array.isArray(v[0][B]));
await read("issue: issuesOf uses the index", C.issuesOfProgram(ISSUE, "g1"),
  (v) => JSON.stringify(v).includes("i1"));

// ── Inbox: the rest of the verbs, and the capabilities ──────────────────────
await write("inbox: alice opens an invite-only locker", alice, C.newLockerProgram(INBOX, "private", "invite"),
  (v) => JSON.stringify(v).includes("created"));
await write("inbox: bob CANNOT send to an invite-only locker", bob,
  C.sendProgram(INBOX, A, "private", `{"type": "spam", "body": "hi"}`),
  (v) => JSON.stringify(v).includes("invite-only"));

// A granted read cap, used in the term that obtained it.
await write("inbox: bob fills alice's inbox with two types", bob,
  C.sendProgram(INBOX, A, "inbox", `{"type": "note", "body": "one"}`),
  (v) => JSON.stringify(v).includes("sent"));
await write("inbox: bob adds a second type", bob,
  C.sendProgram(INBOX, A, "inbox", `{"type": "memo", "body": "two"}`),
  (v) => JSON.stringify(v).includes("sent"));
await write("inbox: a granted READ cap answers that locker's bodies", alice,
  viaSelf(INBOX, `@found!(*deployerId, "grantRead", ["inbox"], *ret) |
            for (@answer <- ret) {
              match answer {
                ("granted", "read", _, cap) => {
                  @cap!(Nil, *r2) | for (@msgs <- r2) { deployId!(["viaGrantedRead", msgs]) }
                }
                _ => { deployId!(["unexpected", answer]) }
              }
            }`),
  (v) => JSON.stringify(v).includes("viaGrantedRead") && JSON.stringify(v).includes("one"));

await write("inbox: take consumes one type and leaves the other", alice, C.takeProgram(INBOX, "inbox", "note"),
  (v) => JSON.stringify(v).includes("took") && JSON.stringify(v).includes("one"));
await read("inbox: the other type survived", C.countInProgram(INBOX, A, "inbox", "memo"), (v) => v[0] === 1);
await read("inbox: the taken type is gone", C.countInProgram(INBOX, A, "inbox", "note"), (v) => v[0] === 0);

// THE capability flow: alice grants a send cap for her invite-only locker and
// DELIVERS it into bob's inbox in the same term. Bob then receives it, binds it
// out of the message, and uses it — the thing rgov's inbox was for.
await write("inbox: bob opens his own locker", bob, C.newLockerProgram(INBOX, "inbox", "open"),
  (v) => JSON.stringify(v).includes("created"));
await write("inbox: alice grants a SEND cap and delivers it to bob", alice,
  viaSelf(INBOX, `@found!(*deployerId, "grantSend", ["private"], *ret) |
            for (@answer <- ret) {
              match answer {
                ("granted", "send", _, cap) => {
                  @found!(*deployerId, "send", [${JSON.stringify(B)}, "inbox",
                          {"type": "cap", "body": cap}], *ret2) |
                  for (@sent <- ret2) { deployId!(["delivered", sent]) }
                }
                _ => { deployId!(["unexpected", answer]) }
              }
            }`),
  (v) => JSON.stringify(v).includes("delivered"));
await write("inbox: bob receives the cap and USES it", bob,
  viaSelf(INBOX, `@found!(*deployerId, "receive", ["inbox"], *ret) |
            for (@answer <- ret) {
              match answer {
                ("received", msgs) => {
                  match msgs.getOrElse("cap", []) {
                    [m ..._] => {
                      match m {
                        {"body": cap, ..._} => {
                          @cap!({"type": "secret", "body": "from bob"}, *r2) |
                          for (@x <- r2) { deployId!(["usedCap", x]) }
                        }
                        _ => { deployId!(["no body", m]) }
                      }
                    }
                    _ => { deployId!(["no cap message", msgs]) }
                  }
                }
                _ => { deployId!(["unexpected", answer]) }
              }
            }`),
  (v) => JSON.stringify(v).includes("usedCap"));
await read("inbox: the cap wrote into the invite-only locker", C.countInProgram(INBOX, A, "private", "secret"),
  (v) => v[0] === 1);

// Requirement 5, the push half: a first message to somebody who has never acted
// must not bounce. Carol has done nothing at all on this contract.
const carolA = revAddressOf(keyOf("carol"));
await write("inbox: a first send to a stranger CREATES their locker", alice,
  C.sendProgram(INBOX, carolA, "inbox", `{"type": "hello", "body": "welcome"}`),
  (v) => JSON.stringify(v).includes("locker created"));
await read("inbox: the stranger now has a locker", C.countInProgram(INBOX, carolA, "inbox", "hello"),
  (v) => v[0] === 1);
await write("inbox: but only the DEFAULT tag is auto-created", alice,
  C.sendProgram(INBOX, carolA, "vault", `{"type": "x", "body": "y"}`),
  (v) => JSON.stringify(v).includes("no such locker"));

// ── Group: the rest ─────────────────────────────────────────────────────────
await write("group: alice (admin) promotes bob", alice,
  C.writeProgram(GROUP, "self", "setRole", ['"g1"', JSON.stringify(B), '"admin"']),
  (v) => JSON.stringify(v).includes("role"));
await read("group: adminsOf now has both", C.adminsOfProgram(GROUP, "g1"), (v) => v[0]?.length === 2);
await write("group: bob censures alice", bob, C.censureProgram(GROUP, "g1", A),
  (v) => JSON.stringify(v).includes("censured"));
const censures = await read("group: censuresOf -> censure arg 1", C.censuresOfProgram(GROUP, "g1"),
  (v) => Array.isArray(v[0]) && v[0][0]?.[0] === B && v[0][0]?.[1] === A);
await write("group: bob un-censures alice", bob,
  C.writeProgram(GROUP, "self", "uncensure", ['"g1"', JSON.stringify(A)]),
  (v) => JSON.stringify(v).includes("uncensured"));
await read("group: censuresOf is empty again", C.censuresOfProgram(GROUP, "g1"), (v) => v[0]?.length === 0);

await write("group: bob delegates on ONE issue only", bob, C.delegateProgram(GROUP, "g1", A, "i1"),
  (v) => JSON.stringify(v).includes("delegated"));
await write("group: bob drops his standing delegation", bob,
  C.writeProgram(GROUP, "self", "undelegate", ['"g1"', "Nil"]),
  (v) => JSON.stringify(v).includes("undelegated"));
await read("group: standing delegation is gone", C.delegationsOfProgram(GROUP, "g1", null),
  (v) => Object.keys(v[0] ?? {}).length === 0);
await read("group: the per-issue one overrides it", C.delegationsOfProgram(GROUP, "g1", "i1"),
  (v) => v[0]?.[B] === A);

await write("group: an invite-only group refuses an uninvited join", alice,
  C.createGroupProgram(GROUP, "g2", "Closed", "invite"),
  (v) => JSON.stringify(v).includes("created"));
await write("group: bob cannot join g2 uninvited", bob, C.joinGroupProgram(GROUP, "g2", "Bob"),
  (v) => JSON.stringify(v).includes("not invited"));
await write("group: alice invites bob to g2", alice, C.inviteProgram(GROUP, "g2", B),
  (v) => JSON.stringify(v).includes("invited"));
await write("group: now bob can join g2", bob, C.joinGroupProgram(GROUP, "g2", "Bob"),
  (v) => JSON.stringify(v).includes("joined"));
// The last admin guard (rhogov#75 item 4): g2 has one admin, alice, and a member, bob.
await write("group: the last admin cannot demote herself", alice,
  C.writeProgram(GROUP, "self", "setRole", ['"g2"', JSON.stringify(A), '"member"']),
  (v) => JSON.stringify(v).includes("last admin"));
await write("group: the last admin cannot leave while bob remains", alice,
  C.writeProgram(GROUP, "self", "leave", ['"g2"']),
  (v) => JSON.stringify(v).includes("last admin"));
await read("group: g2 still has its admin", C.adminsOfProgram(GROUP, "g2"),
  (v) => Array.isArray(v[0]) && v[0].includes(A));
await write("group: bob leaves g2", bob, C.writeProgram(GROUP, "self", "leave", ['"g2"']),
  (v) => JSON.stringify(v).includes("left"));

// An invitation can be withdrawn (quantum-os#246): a mistaken one must not stay
// published forever.
const carolKey = keyOf("carol"), C3 = revAddressOf(carolKey);
await write("group: alice invites carol to g2", alice, C.inviteProgram(GROUP, "g2", C3),
  (v) => JSON.stringify(v).includes("invited"));
await write("group: bob (not a g2 admin) CANNOT withdraw it", bob, C.uninviteProgram(GROUP, "g2", C3),
  (v) => JSON.stringify(v).includes("not an admin"));
await write("group: alice withdraws carol's invitation", alice, C.uninviteProgram(GROUP, "g2", C3),
  (v) => JSON.stringify(v).includes("uninvited"));
await read("group: carol is no longer published as invited", C.readProgram(GROUP, "invitedOf", ['"g2"']),
  (v) => Array.isArray(v[0]) && !v[0].includes(C3));
await write("group: carol cannot join on a withdrawn invitation", carolKey, C.joinGroupProgram(GROUP, "g2", "Carol"),
  (v) => JSON.stringify(v).includes("not invited"));
await write("group: withdrawing an invitation that is not there says so", alice, C.uninviteProgram(GROUP, "g2", C3),
  (v) => JSON.stringify(v).includes("not invited"));
await write("group: the last MEMBER may always leave", alice, C.writeProgram(GROUP, "self", "leave", ['"g2"']),
  (v) => JSON.stringify(v).includes("left"));

// ── Issue: the rest, including the bearer ballot ────────────────────────────
await write("issue: alice adds an option", alice,
  C.writeProgram(ISSUE, "self", "addOption", ['"i1"', '"maybe"']),
  (v) => JSON.stringify(v).includes("option"));
await write("issue: carol is NOT on the roll and cannot cast", keyOf("carol") ? keyOf("carol") : bob,
  C.castProgram(ISSUE, "i1", ["no"]),
  (v) => JSON.stringify(v).includes("not on the roll"));

// enroll mints a bearer ballot bound to (issue, addr) — used in the same term.
const carolAddr = revAddressOf(keyOf("carol"));
await write("issue: enroll mints a ballot cap that casts for a guest", alice,
  viaSelf(ISSUE, `@found!(*deployerId, "enroll", ["i1", ${JSON.stringify(carolAddr)}], *ret) |
            for (@answer <- ret) {
              match answer {
                ("enrolled", _, _, cap) => {
                  @cap!(["no"], *r2) | for (@x <- r2) { deployId!(["usedBallot", x]) }
                }
                _ => { deployId!(["unexpected", answer]) }
              }
            }`),
  (v) => JSON.stringify(v).includes("usedBallot"));
await read("issue: the guest's ballot landed under THEIR address", C.ballotsOfProgram(ISSUE, "i1"),
  (v) => Array.isArray(v[0]?.[carolAddr]));

// The electorate must be refreshable: `open` is idempotent, so a roll fixed at
// first push would lock out anyone who publishes a chain address later.
await write("issue: the opener refreshes the roll", alice,
  C.setRollProgram(ISSUE, "i1", [A, B, carolAddr]),
  (v) => JSON.stringify(v).includes("roll") && JSON.stringify(v).includes("3"));
await write("issue: a non-opener cannot refresh it", bob,
  C.setRollProgram(ISSUE, "i1", [B]),
  (v) => JSON.stringify(v).includes("not the opener"));
await read("issue: the new roll took", C.readProgram(ISSUE, "votersOf", ['"i1"']),
  (v) => v[0]?.length === 3);
// The roll stays editable after ballots, but never quietly (quantum-os#244):
// each change is logged with how many ballots had been cast before it.
await read("issue: the roll change is logged, with the ballots already cast",
  C.readProgram(ISSUE, "rollLogOf", ['"i1"']),
  (v) => Array.isArray(v[0]) && v[0].length === 1 && v[0][0].voters === 3 && v[0][0].ballotsBefore === 2);

await write("issue: bob CANNOT close someone else's issue", bob,
  C.closeIssueProgram(ISSUE, "i1"), (v) => JSON.stringify(v).includes("not the opener"));
await write("issue: bob CANNOT post a result on alice's issue", bob,
  C.writeProgram(ISSUE, "self", "propose", ['"i1"', '"no"']),
  (v) => JSON.stringify(v).includes("not the opener"));
await write("issue: alice records a proposed tally", alice,
  C.writeProgram(ISSUE, "self", "propose", ['"i1"', '"yes"']),
  (v) => JSON.stringify(v).includes("proposed"));
await read("issue: the result is keyed by who proposed it",
  C.readProgram(ISSUE, "resultsOf", ['"i1"']), (v) => v[0]?.[A] === "yes" && Object.keys(v[0]).length === 1);
await write("issue: alice closes it", alice, C.closeIssueProgram(ISSUE, "i1"),
  (v) => JSON.stringify(v).includes("closed"));
await write("issue: a closed issue refuses a ballot", bob, C.castProgram(ISSUE, "i1", ["yes"]),
  (v) => JSON.stringify(v).includes("not open"));
await write("issue: a closed issue refuses a roll change too", alice,
  C.setRollProgram(ISSUE, "i1", [A]), (v) => JSON.stringify(v).includes("closed"));

// ── migration: does a CAPABILITY survive it? ────────────────────────────────
// The whole reason the vault refuses admin dump/load. A client cannot serialise
// an unforgeable, so the only migration that preserves one happens in a single
// term, contract to contract.
const INBOX2 = uriOf(await write("install a SECOND Inbox to migrate into", alice, C.installInboxProgram()));
if (INBOX2) {
  // Put a live capability in alice's locker: bob grants a send cap for his own
  // locker and delivers it to her, in one term.
  await write("bob delivers a send-cap into alice's locker", bob,
    viaSelf(INBOX, `@found!(*deployerId, "grantSend", ["inbox"], *ret) |
            for (@answer <- ret) {
              match answer {
                ("granted", "send", _, cap) => {
                  @found!(*deployerId, "send", [${JSON.stringify(A)}, "inbox",
                          {"type": "cap", "body": cap}], *ret2) |
                  for (@sent <- ret2) { deployId!(["delivered", sent]) }
                }
                _ => { deployId!(["unexpected", answer]) }
              }
            }`),
    (v) => JSON.stringify(v).includes("delivered"));

  await write("alice migrates her lockers to the new Inbox", alice,
    C.migrateLockersProgram(INBOX, INBOX2), (v) => JSON.stringify(v).includes("imported"));
  await read("the capability arrived at the new contract",
    C.countInProgram(INBOX2, A, "inbox", "cap"), (v) => v[0] === 1);
  await write("importing twice is refused", alice,
    C.migrateLockersProgram(INBOX, INBOX2), (v) => JSON.stringify(v).includes("already has lockers"));

  // THE point: take the migrated capability out of the NEW contract and use it.
  // If an unforgeable had been serialised anywhere in between, this is dead.
  await write("the MIGRATED capability still works", alice,
    viaSelf(INBOX2, `@found!(*deployerId, "receive", ["inbox"], *ret) |
            for (@answer <- ret) {
              match answer {
                ("received", msgs) => {
                  match msgs.getOrElse("cap", []) {
                    [m ..._] => {
                      match m {
                        {"body": cap, ..._} => {
                          @cap!({"type": "afterMigration", "body": "it lived"}, *r2) |
                          for (@x <- r2) { deployId!(["usedAfterMigration", x]) }
                        }
                        _ => { deployId!(["no body", m]) }
                      }
                    }
                    _ => { deployId!(["no cap message", msgs]) }
                  }
                }
                _ => { deployId!(["unexpected", answer]) }
              }
            }`),
    (v) => JSON.stringify(v).includes("usedAfterMigration"));
  await read("…and it wrote into bob's locker on the OLD contract",
    C.countInProgram(INBOX, B, "inbox", "afterMigration"), (v) => v[0] === 1);

  await write("a vault refuses whole-contract dump", alice, C.dumpProgram(INBOX2),
    (v) => JSON.stringify(v).includes("no whole-contract dump"));
}

// ── admin: migration, and who may do it ─────────────────────────────────────
await write("admin: bob is NOT the installer", bob, C.dumpProgram(GROUP),
  (v) => JSON.stringify(v).includes("not the installer"));
await write("admin: alice can dump", alice, C.dumpProgram(GROUP),
  (v) => JSON.stringify(v).includes("dump") && JSON.stringify(v).includes("g1"));
await write("admin: load refuses a non-empty cell", alice, C.loadProgram(GROUP, "{}"),
  (v) => JSON.stringify(v).includes("not empty"));
await write("admin: version", alice, C.writeProgram(GROUP, "admin", "version", [], { asAdmin: true }),
  (v) => JSON.stringify(v).includes("Group/4"));

// ── the natives read what the contracts wrote ────────────────────────────────
const rl = (x) => JSON.stringify(x);
const trip = (t) => `[${t.map(([a, b, c]) => `(${rl(a)}, ${rl(b)}, ${c})`).join(", ")}]`;
const lst = (t) => `[${t.map(rl).join(", ")}]`;
const R = ratings?.[0] ?? [], AD = admins?.[0] ?? [], BA = ballots?.[0] ?? {};

const levels = await read("native: trustLevels(ratingsOf, adminsOf)",
  `new return, trustLevels(\`rho:gov:trustLevels\`), r in {
     trustLevels!(${trip(R)}, ${lst(AD)}, *r) | for (@lv <- r) { return!(lv) }
   }`, (v) => v[0] && typeof v[0] === "object");

const LV = levels?.[0] ?? {};
const weights = await read("native: resolveWeights(voters, delegationsOf, levels)",
  `new return, resolveWeights(\`rho:gov:resolveWeights\`), r in {
     resolveWeights!(${lst(Object.keys(BA))}, {${rl(B)}: ${rl(A)}}, ${JSON.stringify(LV)}, *r) |
     for (@w <- r) { return!(w) }
   }`, (v) => v[0] && typeof v[0] === "object");

await read("native: tally(ballotsOf, weights, approval)",
  `new return, tally(\`rho:gov:tally\`), r in {
     tally!(${JSON.stringify(BA)}, ${JSON.stringify(weights?.[0] ?? {})}, "approval", *r) |
     for (@w <- r) { return!(w) }
   }`, (v) => v.length > 0);

// censure takes the SAME ratings list as trustLevels — a rating is the stake a
// censure slashes, which is why ratingsOf and vouchersOf answer one list.
await read("native: censure(censuresOf, levels, vouchersOf)",
  `new return, censure(\`rho:gov:censure\`), r in {
     censure!([(${rl(B)}, ${rl(A)})], ${JSON.stringify(LV)}, ${trip(R)}, *r) |
     for (@out <- r) { return!(out) }
   }`, (v) => v.length > 0);

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
