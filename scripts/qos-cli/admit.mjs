// Admit validators to a running chain, enforcing the ordering the network actually needs.
//
// The rule: a validator joins and syncs BEFORE it is trusted or bonded. Nothing in the protocol enforces
// this - a `bond` deploy needs only the newcomer's public key, so a key whose node is stopped can be bonded
// successfully, and the deploy is submitted through a node that can propose (deploys are not gossiped, and an
// unbonded node cannot propose, so the newcomer can never submit its own admission).
//
// Two things make the wrong order expensive once the bond lands:
//
//   * the validator set is consensus weight immediately, and it counts in the >2/3 denominator finality needs,
//     so a bonded validator that is not running is silent stake that can stall the fringe for everyone;
//   * a node decides whether it may propose from the newest block in its OWN DAG, so one that has not synced
//     is told `Proposal failed: ReadOnlyMode` (ProposeStatus::NotBonded) however bonded the chain says it is.
//
// So this tool runs four stages and refuses to skip them: preflight the newcomer's node (reachable, synced,
// following), trust + bond, wait for the epoch boundary that activates it, then the postflight that is the
// only conclusive evidence - make the newcomer's own node propose. That last step is what a successful
// admission *means*: the stake is in the active set AND its owner can speak. `commit` without it is a guess,
// and it is the check that would have caught every failure we hit.
//
//   node admit.mjs --config newcomers.json            # preflight, admit, activate, postflight
//   node admit.mjs --config newcomers.json --dry-run  # preflight only
//
// Config:
//   {
//     "url": "https://testnet.rhobot.net",     // a node that can propose, used to submit deploys
//     "trusteeKey": "<hex>",                   // a trusted funded key, pays for `trust`        (or env KEY_DAVE)
//     "tickKey": "<hex>",                      // any funded key, pays for the ticks            (or env KEY)
//     "stake": 100,
//     "epochLength": 10,
//     "newcomers": [
//       { "name": "B", "key": "/path/to/key", "node": "http://127.0.0.1:40403", "ssh": "root@host",
//         "rnode": "/usr/local/bin/rnode", "grpcPort": 40402 }
//     ]
//   }
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deployTerm, nodeStatus, publicKeyOf, revAddressOf } from "./rholang-client.mjs";

const args = process.argv.slice(2);
const cfgPath = args[args.indexOf("--config") + 1];
const DRY = args.includes("--dry-run");
if (!cfgPath || cfgPath.startsWith("--")) {
  console.error("usage: node admit.mjs --config <file> [--dry-run]");
  process.exit(2);
}
const conf = JSON.parse(readFileSync(cfgPath, "utf8"));
const URL = conf.url;
const TRUSTEE = conf.trusteeKey || process.env.KEY_DAVE;
const TICK = conf.tickKey || process.env.KEY;
const STAKE = Number(conf.stake || 100);
const EPOCH = Number(conf.epochLength || 10);
const TOLERANCE = Number(conf.syncTolerance || 2);
const cfg = (key) => ({ url: URL, key, phloLimit: 500_000, phloPrice: 1, shard: "/root" });
// `key` may be a path or the hex itself; every use below wants the hex.
for (const n of conf.newcomers) {
  const raw = (n.key || "").trim();
  n.secret = /^[0-9a-f]{64}$/i.test(raw) ? raw : readFileSync(raw, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(n.secret)) {
    console.error(`  FAIL: ${n.name}: ${n.key} does not contain a 64-character base16 key`);
    process.exit(1);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A rejected fetch inside the client must not print a stack trace over a diagnosis.
process.on("unhandledRejection", (e) => {
  console.error(`  FAIL: ${(e && e.message) || e}`);
  process.exit(1);
});

const fail = (msg) => {
  console.error(`  FAIL: ${msg}`);
  process.exitCode = 1;
};

/** What the chain says, from the node we submit through. */
const chain = async () => {
  const s = await nodeStatus({ url: URL }).catch(() => ({}));
  let fin = null;
  try {
    const j = await (await fetch(`${URL}/api/last-finalized-block`)).json();
    fin = j.blockInfo ? j.blockInfo.blockNumber : null;
  } catch {}
  let active = [];
  try {
    active = ((await (await fetch(`${URL}/api/blocks/1`)).json())[0].bonds) || [];
  } catch {}
  return { height: s.latestBlockNumber, finalized: fin, active };
};
const activeOf = (c) => c.active.map((e) => String(e.validator).toLowerCase());
const show = (label, c) =>
  console.log(
    `  ${label}: height=${c.height} finalized=${c.finalized ?? "(none)"} active=[` +
      c.active.map((e) => `${String(e.validator).slice(0, 8)}:${e.stake}`).join(" ") +
      "]",
  );

const step = async (name, key, term, wait = 7000) => {
  const r = await deployTerm(cfg(key), term);
  const ok = r.ok;
  console.log(`  ${name}: ${ok ? "accepted" : "REJECTED " + JSON.stringify(r).slice(0, 140)}`);
  await sleep(wait);
  return ok;
};
const tick = async () => {
  await deployTerm(cfg(TICK), 'stdout!("tick")');
  await sleep(5000);
};

// ---------------------------------------------------------------- stage 1: preflight
const preflight = async (n, c) => {
  const pk = publicKeyOf(n.secret);
  console.log(`\n  --- ${n.name}: ${pk.slice(0, 16)}…  ${revAddressOf(n.secret)}`);
  let s;
  try {
    s = await nodeStatus({ url: n.node });
  } catch (e) {
    fail(`${n.name}: its node at ${n.node} is not answering (${e.message}). Start it and let it sync first.`);
    return null;
  }
  const behind = (c.height ?? 0) - (s.latestBlockNumber ?? 0);
  console.log(
    `      node: height=${s.latestBlockNumber} peers=${s.peers} (chain ${c.height})` +
      (s.devMode ? " devMode" : ""),
  );
  if (!(s.peers >= 1)) {
    fail(`${n.name}: its node has no peers, so it is not following the chain.`);
    return null;
  }
  if (behind > TOLERANCE) {
    fail(
      `${n.name}: its node is ${behind} blocks behind (${s.latestBlockNumber} vs ${c.height}). ` +
        `Wait for the LFS restore to finish - a node that has not synced will be refused ReadOnlyMode ` +
        `afterwards, and its stake is consensus weight in the meantime.`,
    );
    return null;
  }
  return { pk, ssh: n.ssh, rnode: n.rnode || "/usr/local/bin/rnode", grpcPort: n.grpcPort || 40402 };
};

// ------------------------------------------------------- stage 4: the conclusive check
const canPropose = (n, t) => {
  if (!t.ssh) {
    console.log(
      `      (no ssh configured for ${n.name}: check it by hand - \`${t.rnode} --profile docker ` +
        `--grpc-port ${t.grpcPort} propose\` from https://github.com/rhovision-org/rholo/pull/77 ` +
        `or later; "Block ... created and added" is the success)`,
    );
    return true;
  }
  try {
    const out = execFileSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", t.ssh,
       `${t.rnode} --profile docker --grpc-port ${t.grpcPort} propose 2>&1 | tail -1`],
      { encoding: "utf8", timeout: 60_000 },
    ).trim();
    if (/created and added/i.test(out)) {
      console.log(`      postflight: its node proposed - ${out.slice(0, 96)}`);
      return true;
    }
    fail(
      `${n.name}: its node cannot propose (${out}). Either its key is not the key that was bonded, or it ` +
        `has not synced the block carrying the bond. It is active but silent, which is the state the ` +
        `network cannot make progress in.`,
    );
    return false;
  } catch (e) {
    fail(`${n.name}: postflight propose failed to run: ${e.message}`);
    return false;
  }
};

// -------------------------------------------------------------------------- the run
let c = await chain();
show("before", c);
const ready = [];
for (const n of conf.newcomers) {
  const t = await preflight(n, c);
  if (t) ready.push({ n, t });
}
if (ready.length === 0) {
  console.error("  no newcomer is ready to be admitted");
  process.exit(1);
}
if (DRY) {
  console.log(`\n  dry run: ${ready.length} ready (${ready.map((r) => r.n.name).join(", ")}); nothing submitted`);
  process.exit(process.exitCode || 0);
}

for (const { n, t } of ready) {
  await step(`trust(${n.name})`, TRUSTEE,
    `new pos(\`rho:rchain:pos\`), deployerId(\`rho:rchain:deployerId\`), ret in {
       pos!("trust", [*deployerId, "${t.pk}".hexToBytes(), *ret]) | for (_ <- ret) { Nil }
     }`);
  await step(`bond(${n.name}, ${STAKE})`, n.secret,
    `new pos(\`rho:rchain:pos\`), deployerId(\`rho:rchain:deployerId\`), ret in {
       pos!("bond", [*deployerId, ${STAKE}, *ret]) | for (_ <- ret) { Nil }
     }`);
}

console.log("");
c = await chain();
show("after bonds", c);
const wanted = new Set(ready.map((r) => r.t.pk.toLowerCase()));
for (let i = 1; i <= 16 && !activeOf(c).some((v) => wanted.has(v)); i++) {
  await tick();
  c = await chain();
  show(`tick ${i}`, c);
  // Activation happens on a boundary; no point ticking past the next one.
  if (EPOCH > 1 && (c.height ?? 0) % EPOCH === 0 && i > 1) continue;
}
for (const { n, t } of ready) {
  const active = activeOf(c).includes(t.pk.toLowerCase());
  if (!active) {
    fail(`${n.name}: not in the active set yet (the bond may have been dropped - see #74)`);
    continue;
  }
  console.log(`  ${n.name}: active`);
  canPropose(n, t);
}
console.log(
  process.exitCode ? "\n  admission INCOMPLETE - see the FAIL lines above" : "\n  admission complete",
);
