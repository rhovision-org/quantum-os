#!/usr/bin/env node
// QuantumOS room-agent daemon — a generalized, trust-governable member.
//
// A persistent peer that joins a room as a FULL MEMBER (stable cap:peer + dyncap
// identity), watches presence + the message stream, and posts *measured* nudges
// according to its --role. The facilitator is one role; `scribe` and `greeter`
// show the generality. It has NO special authority: it only posts `chat`; the
// group decides. Because it is an ordinary trust-weighted peer, the room can
// `/gov trust` it up or `/gov censure` it down (full trust integration: see PR B).
//
// MULTIPLE AGENTS IN ONE ROOM: agents tag their `name` envelope with their role,
// so they recognize each other and (a) elect a single LEAD for each shared
// proactive duty — only the lowest-peerId agent that performs a duty acts, so N
// agents don't all greet — and (b) count their posts COLLECTIVELY against the
// human fair-share, so adding agents can't inflate the budget.
//
// MEASURED DISRUPTION is the whole point: a global post budget per window, a
// minimum gap between posts, per-behaviour cooldowns, a collective fair-share vs
// the humans, and "quiet by default — only speak on a clear signal".
//
// Reuses the qos-cli transport/identity exactly like qos-daemon.mjs.
// State (stable identity + who-we've-greeted) lives under --state.

import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QOSPeer } from "./qospeer.mjs";
import { openRoomMemory, MEMORY_SIGNED_KINDS } from "./room-memory.mjs";
import { generateCapability, validateCapability, parseTwists,
         achievesZfa, achievesZfaPairwise, signedAction, CENSUS_ADMITTED } from "./zfa.mjs";
import { newDynCapState, signEnvelope, serializeState, deserializeState } from "./dyncap.mjs";
import { makeAdvisor } from "./facilitator-advisor.mjs";
import { createGameRecorder, compactForPrompt, trustWeightsFromGroups } from "./game-log.mjs";
import { ROLES, DEFAULT_ROLE, resolveRole, dutiesOf } from "./agent-roles.mjs";
import { trustLevels, discreditedMembers, isMember, groupHasRatings, normalizeGroup, TRUST_MAX } from "./gov.mjs";
import { MACROS } from "./rholang-macros.mjs";
import { DEFAULT_CONFIG as REV_DEFAULT_CONFIG, revAddressOf, deployTerm as revDeployTerm } from "./rholang-client.mjs";
import { createFaucetServer } from "./faucet-http.mjs";

const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
// "name" is always signed. When this agent carries the room's memory
// (--persist), the state it re-serves must be signed too or receiving peers
// will not trust it — see MEMORY_SIGNED_KINDS in room-memory.mjs.
const SIGNED_KINDS = new Set(["name"]);
const PERSIST_SIGNED_KINDS = new Set(["name", ...MEMORY_SIGNED_KINDS]);

const USAGE = `qos agent — measured, trust-governable room-agent daemon

Usage:
  node agent.mjs --room <cap:room:… | room-URL> [--role facilitator] [options]

Options:
  --room <cap|url>   Room capability token or a quantum-os URL (#room=…). (required)
  --role <r>         Agent role: ${Object.keys(ROLES).join(", ")} (default: ${DEFAULT_ROLE}).
                     \`observer\` records live games: \`/observer start <label> [payoffs a,b,c,d]
                     [stag=…] [hare=…] [predict: …]\` … \`/observer stop\` → games/<ts>-<label>.json
                     (+ .events.jsonl raw); \`/observer summarize\` writes the AI summary (--ai).
  --name <s>         Display name (default: the role name).
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL}).
  --state <dir>      State directory (default: ./.qos-agent).
  --persist [dir]    Carry the room's memory: persist lemmas/currencies/series/
                     gov/transcript and re-serve them to every joiner, the duty
                     qos-daemon.mjs performs standalone. Costs one fewer peer
                     against the signaling room-size ceiling. Defaults to --state.
  --budget <n>       Max posts per 5-min window (default: 4).
  --silent-min <m>   Minutes of silence before soliciting a quiet member (default: 6).
  --quiet            Less assertive (halves budget, longer cooldowns).
  --active           More assertive (raises budget, shorter cooldowns).
  --ai               Enable the AI advisor (stimulate + disagreement-synthesis + ask).
  --ai-backend <b>   api (default; needs ANTHROPIC_API_KEY, pay-as-you-go credits) or
                     claude-code (shells out to the local \`claude\` CLI = your Claude
                     subscription, no API credits — must be installed + logged in).
  --about <url>      Link to the room's about page, shown in intro/help
                     (default: the QuantumOS MyRoom page).
  --turn             Fetch a TURN relay (GET /turn). Off by default — the agent
                     is data-only and reaches peers over the flood relay, so a
                     relay only adds ICE-candidate traffic through signaling.
                     Turn on only if this agent must span a NAT boundary itself.
  --ai-model <m>     Model. api default: claude-haiku-4-5-20251001;
                     claude-code default: the CLI's configured model.
  --key <hex>        TEST-SYSTEM ONLY: a secp256k1 REV deploy key (64 hex
                     chars). Activates \`/<role> faucet [address]\`, which
                     sends a fixed amount of TEST REV to a REV address on
                     request. This agent then HOLDS A SIGNING KEY IN MEMORY —
                     a deliberate exception to "an agent never holds a key"
                     (see rholang-agent.mjs). Never use a key with real value.
  --faucet-http <port>
                     Also serve the faucet over HTTP (needs --key):
                     POST /faucet {"address"} or GET /faucet?address=… →
                     the same transfer. For a wallet that cannot join the
                     room. Rate-limited — one grant per address per day,
                     5 per client per hour — because unlike the room command
                     a port is reachable by anyone. Behind a TLS proxy
                     (X-Forwarded-For is honoured); a wallet calls
                     https://<host>/faucet.
  --rnode <url>      The rnode the faucet deploys to (default: rholang-
                     client.mjs's — the rhobot.net dev instance). The same
                     key holds REV separately on every chain, so a faucet
                     for the playground and one for testnet are two
                     facilitators with two --rnode values. On the node's
                     own host, http://127.0.0.1:40403 skips the proxy.
  --verbose          Log every inbound message + suppressed nudges.
  --help, -h         Show this help.

Run several with different --role (and distinct --state dirs) in one room; they
de-conflict shared duties automatically. Say \`/<role>\` (e.g. \`/facil\`, \`/scribe\`)
or "anyone here?" and the agent replies. It is a full trust-weighted member: the room
governs its voice via \`/gov trust\` / \`/gov censure\` (it posts up to its trust level
per window, one rung below a same-rated human; \`/<role> trust\` shows its standing, \`/<role> health\` its diagnostics).
Runs until Ctrl-C.`;

export function parseArgs(argv) {
  const a = { signal: DEFAULT_SIGNAL, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--room") a.room = argv[++i];
    else if (x === "--role") a.role = argv[++i];
    else if (x === "--name") a.name = argv[++i];
    else if (x === "--signal") a.signal = argv[++i];
    else if (x === "--state") a.state = argv[++i];
    else if (x === "--persist") a.persist = argv[++i] ?? "";
    else if (x === "--budget") a.budget = Number(argv[++i]);
    else if (x === "--silent-min") a.silentMin = Number(argv[++i]);
    else if (x === "--quiet") a.quiet = true;
    else if (x === "--active") a.active = true;
    else if (x === "--ai") a.ai = true;
    else if (x === "--ai-backend") a.aiBackend = argv[++i];
    else if (x === "--ai-model") a.aiModel = argv[++i];
    else if (x === "--about") a.about = argv[++i];
    else if (x === "--turn") a.turn = true;
    else if (x === "--key") a.key = argv[++i];
    else if (x === "--faucet-http") a.faucetHttp = Number(argv[++i]);
    else if (x === "--rnode") a.rnode = argv[++i];
    else if (x === "--verbose") a.verbose = true;
    else if (x === "--help" || x === "-h") a.help = true;
  }
  return a;
}

function extractRoomCap(s) {
  if (!s) return null;
  if (s.startsWith("cap:room:")) return s;
  const frag = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const m = /room=([^&]+)/.exec(frag);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return s.startsWith("cap:") ? s : null;
}

const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
// Atomic: write a temp file in the same directory, then rename over the target.
// identity.json holds the dyncap seed — a crash mid-write leaves it truncated,
// readJSON falls back to null, and the daemon mints a FRESH identity: a forked
// dyncap chain against every peer's TOFU pin, and its `/gov trust` standing
// (keyed by peerId) silently gone.
const writeJSON = (p, o) => {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, p);
};
const short = (id) => String(id ?? "").slice(0, 8);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function run(args) {
  if (args.help || !args.room) { console.log(USAGE); if (typeof process !== "undefined") process.exit(args.help ? 0 : 1); return; }

  const roleKey = (args.role ?? DEFAULT_ROLE).toLowerCase();
  const role = resolveRole(roleKey);
  if (!role) { console.error(`[agent] unknown --role "${args.role}". Known: ${Object.keys(ROLES).join(", ")}`); process.exit(1); return; }
  const CMD = role.cmd;                                   // command prefix, e.g. "facil"
  const ABOUT_URL = args.about ?? "https://github.com/rhovision-org/quantum-os/blob/main/MyRoom.md";
  const TAG = `[${CMD}]`;                                 // log tag
  const aliases = [...new Set([CMD, role.name])];         // command spellings, e.g. facil|facilitator
  const aliasAlt = aliases.map(escapeRe).join("|");
  // Accept one or two leading slashes: `//facil` is how a user escapes a
  // leading `/` in some clients, and it can reach the room as literal text.
  const cmdRe = new RegExp(`^/{1,2}(?:${aliasAlt})\\b\\s*(\\w+)?`, "i");
  const askStripRe = new RegExp(`^/{1,2}(?:${aliasAlt})\\s+ask\\b\\s*`, "i");
  const optStripRe = new RegExp(`^/{1,2}(?:${aliasAlt})\\s+(?:optimize|opt)\\b\\s*`, "i");
  const chairStripRe = new RegExp(`^/{1,2}(?:${aliasAlt})\\s+(?:chair|deliberate)\\b\\s*`, "i");
  const gameStartStripRe = new RegExp(`^/{1,2}(?:${aliasAlt})\\s+(?:start|record|begin)\\b\\s*`, "i");
  const faucetStripRe = new RegExp(`^/{1,2}(?:${aliasAlt})\\s+faucet\\b\\s*`, "i");
  const bareNameRe = new RegExp(`^(?:${aliasAlt})\\??$`, "i");
  const anyoneHereRe = new RegExp(`\\b(any\\s?(one|body)|${aliasAlt})\\b[^?]*\\b(here|there|around|online|present|listening)\\b\\??`, "i");
  const greetingRe = /^(hi|hello|hey|hiya|yo|howdy|gm|good\s+(morning|afternoon|evening))[\s!,.]*(all|everyone|folks|there|y'?all)?[\s!,.]*$/;

  const roomId = extractRoomCap(args.room);
  if (!roomId || !roomId.startsWith("cap:room:")) { console.error(`${TAG} could not parse cap:room: from --room`); process.exit(1); return; }
  if (!validateCapability(roomId)) console.warn(`${TAG} warning: room token failed ZFA validation (continuing): ${roomId}`);

  // ---- measured-disruption policy (tunable; --quiet / --active shift it) ----
  // A bad or valueless numeric flag (`--budget abc`, or `--budget` as the last argv)
  // parses to NaN, and NaN silently disables whatever it gates rather than erroring:
  // `postLog.length < NaN` is false, so the agent would hold EVERY nudge forever while
  // looking healthy. Reject it at startup instead.
  const numOpt = (v, flag, min) => {
    if (v === undefined) return undefined;
    if (!Number.isFinite(v) || v < min) { console.error(`${TAG} --${flag} needs a number >= ${min} (got "${v}")`); process.exit(1); }
    return v;
  };
  const budgetOpt = numOpt(args.budget, "budget", 1);
  const silentOpt = numOpt(args.silentMin, "silent-min", 1);
  const scale = args.quiet ? 1.6 : args.active ? 0.6 : 1.0;     // cooldown multiplier
  const WINDOW_MS   = 5 * 60_000;
  const MAX_POSTS   = Math.max(1, Math.round((budgetOpt ?? (args.quiet ? 2 : args.active ? 6 : 4))));
  const MIN_GAP_MS  = Math.round(20_000 * scale);
  const SILENT_MS   = Math.max(60_000, Math.round((silentOpt ?? 6) * 60_000));
  const GREET_DELAY_MS = 4_000;
  const ACTIVE_MS   = 4 * 60_000;
  const DOMINATE_FRAC = 0.6, DOMINATE_MIN = 6;
  const CD = { greet: 0, name: 0, silent: Math.round(10 * 60_000 * scale), dominate: Math.round(8 * 60_000 * scale), discrepancy: Math.round(5 * 60_000 * scale), verify: Math.round(3 * 60_000 * scale), stimulate: Math.round(12 * 60_000 * scale), synthesize: Math.round(9 * 60_000 * scale) };
  const TICK_MS = 30_000;
  const LULL_MS = Math.round(2 * 60_000 * scale);
  const CHAT_RETAIN_MS = 15 * 60_000;

  // ---- TEST REV faucet (opt-in via --key; see rholang-client.mjs's TRUST NOTE) ----
  // A fixed amount, no rate limit (test systems only, by design — see CLAUDE.md).
  // Bad hex is rejected loudly at startup (like numOpt above): a faucet that
  // silently never sends because the key never parsed would just look broken.
  // The vault counts in dust (1 REV = 10^8 dust — wallet.txt, the node's own
  // faucet and r-wallet all use it); the macro's `amount` is dust too. This
  // used to pass 10n straight through, i.e. 10 dust while saying "10 REV".
  const FAUCET_REV = 10n;
  const DUST_PER_REV = 100_000_000n;
  const FAUCET_AMOUNT = FAUCET_REV * DUST_PER_REV;   // what actually moves
  let facilKey = null, facilAddr = null;
  if (args.key) {
    const k = String(args.key).trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(k)) { console.error(`${TAG} --key needs 64 hex chars (a secp256k1 private key), got ${k.length}`); process.exit(1); }
    try { facilAddr = revAddressOf(k); } catch (e) { console.error(`${TAG} --key is not a valid secp256k1 key: ${e?.message ?? e}`); process.exit(1); }
    facilKey = k;
    console.log(`${TAG} TEST REV FAUCET ACTIVE — funding address ${facilAddr}. Fund it via scripts/localnet's genesis wallet, or a transfer; never point --key at a key holding real value.`);
  }
  const rnodeUrl = (args.rnode ?? REV_DEFAULT_CONFIG.url).replace(/\/+$/, "");
  if (args.rnode !== undefined && !/^https?:\/\//.test(rnodeUrl)) { console.error(`${TAG} --rnode needs an http(s) URL, got ${args.rnode}`); process.exit(1); }
  if (facilKey) console.log(`${TAG} faucet deploys to ${rnodeUrl} — the key's REV on THAT chain is what it hands out`);
  const revCfg = () => ({ ...REV_DEFAULT_CONFIG, url: rnodeUrl, key: facilKey });
  // ONE function moves REV, for the room command and the HTTP endpoint alike.
  // A deterministic action — never the advisor's call (see handleFaucet).
  /** A REV balance, read without deploying. null when the node will not say. */
  async function revBalance(addr) {
    const term = `new return, revVault(\`rho:rchain:revVault\`), ret in {
  revVault!("getBalance", ${JSON.stringify(addr)}, *ret) | for (@r <- ret) { return!(r) }
}`;
    try {
      const res = await fetch(`${rnodeUrl}/api/explore-deploy`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(term),
      });
      const j = JSON.parse(await res.text());
      if (typeof j === "string") return null;              // rnode reports an error as a bare string
      const e = (j.expr ?? [])[0];
      return e && typeof e.ExprInt === "number" ? e.ExprInt : null;
    } catch { return null; }
  }

  /** Did the deploy run, and did it error? Read from its own status, by signature. */
  async function deployRan(sig, tries = 12) {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const j = await (await fetch(`${rnodeUrl}/api/v1/deploy-status/${sig}`)).json();
        if (j?.ProcessedWithError) {
          const e = j.ProcessedWithError.deployError ?? j.ProcessedWithError;
          return { ran: true, errored: true, why: JSON.stringify(e).slice(0, 200) };
        }
        if (j?.ProcessedWithSuccess) return { ran: true, errored: false };
      } catch { /* keep waiting */ }
    }
    return { ran: false, errored: false };
  }

  async function faucetSend(addr) {
    // CONFIRM BY THE BALANCE, not by the deploy's return value.
    //
    // This used to read `out.value`, which rholang-client fetches from the
    // deployer key's REGISTRY RESULT SLOT — and that slot is not written on
    // every node (measured: a ProcessedWithSuccess deploy left it empty on the
    // rebuilt playground). `$transfer` answers on `return`, not on
    // `rho:rchain:deployId`, so there was nothing to read either way and
    // `confirmed` could never be true however long it waited. Every successful
    // transfer was reported as "couldn't confirm", which reads like failure and
    // invites a retry — and the retries are what actually happened.
    //
    // So: ask the chain the question the user is really asking. Did the
    // recipient's balance go up?
    const before = await revBalance(addr);
    const term = MACROS.transfer.expand({ amount: FAUCET_AMOUNT, to: addr });
    const out = await revDeployTerm(revCfg(), term, { waitAttempts: 0 });
    if (!out.ok) return { ok: false, message: String(out.message ?? "") };

    const fate = await deployRan(out.sig);
    if (fate.errored) return { ok: false, message: `it ran and errored: ${fate.why}` };

    if (before !== null) {
      for (let i = 0; i < 8; i++) {
        const now = await revBalance(addr);
        if (now !== null && now > before) {
          return { ok: true, confirmed: true, balance: now, deployId: out.sig };
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    // The deploy is in a block and did not error, so the REV is on its way even
    // if the read has not caught up. Say which of those two things we know.
    return { ok: true, confirmed: false, ran: fate.ran, deployId: out.sig };
  }
  if (args.faucetHttp !== undefined) {
    if (!Number.isInteger(args.faucetHttp) || args.faucetHttp <= 0) { console.error(`${TAG} --faucet-http needs a port number`); process.exit(1); }
    if (!facilKey) { console.error(`${TAG} --faucet-http needs --key — there is no faucet to serve without one`); process.exit(1); }
  }

  const advisor = makeAdvisor({ ai: args.ai, backend: args.aiBackend, model: args.aiModel, persona: role.persona, roleName: role.name, cmd: CMD, faucetActive: !!facilKey, log: console.log });

  // ---- identity (stable across restarts), mirroring qos-daemon.mjs ----
  const stateDir = args.state ?? "./.qos-agent";
  const roomHex = roomId.replace(/^cap:room:/, "");
  // ---- game recorder (the observer's instrument; available to every role) ----
  // Records every inbound envelope between `/<cmd> start` and `/<cmd> stop` to its own
  // events file — independent of whether any agent carries the room's memory — then
  // materializes the structured record. See game-log.mjs.
  let games = null;   // created once identity/peerNames exist (below)
  const identityPath = path.join(stateDir, "identity.json");
  const peersPath = path.join(stateDir, "rooms", roomHex, "peers.json");
  let identity = readJSON(identityPath, null);
  let dyncapState;
  if (identity?.peerId && identity?.dyncap) dyncapState = await deserializeState(JSON.stringify(identity.dyncap));
  if (!identity?.peerId || !dyncapState) {
    identity = { peerId: generateCapability("peer"), name: args.name ?? role.name, dyncap: null };
    dyncapState = await newDynCapState();
    identity.dyncap = JSON.parse(serializeState(dyncapState));
    writeJSON(identityPath, identity);
    console.log(`${TAG} new identity ${identity.peerId.slice(0, 18)}…`);
  } else console.log(`${TAG} loaded identity ${identity.peerId.slice(0, 18)}…`);
  const myName = args.name ?? identity.name ?? role.name;
  identity.name = myName;
  const saveIdentity = () => { identity.dyncap = JSON.parse(serializeState(dyncapState)); writeJSON(identityPath, identity); };

  const known = readJSON(peersPath, {});
  const saveKnown = () => writeJSON(peersPath, known);

  // ---- live room model (in-memory) ----
  const peerNames = new Map();     // peerId -> name
  const agents = new Map();        // peerId -> roleKey (other agents that announced themselves)
  const introduced = new Set();    // human peerIds we've self-introduced to this run (re-intro on reconnect)
  const present = new Set();       // peerIds with an open channel
  const spokeAt = new Map();
  const joinedAt = new Map();
  const chatLog = [];              // {peer, at} for all chats (rolling)
  const recentMsgs = [];           // {name, text, at} for AI context (rolling)
  // Screen history for `/<cmd> list [n]` — every chat line and command result the
  // agent saw, oldest first, bounded by count (NOT time, unlike recentMsgs). A
  // scribe's whole job is the record; this is the room's scrollback for a peer
  // whose own browser can't scroll far enough (or joined late).
  const TRANSCRIPT_MAX = 600;
  const LIST_DEFAULT = 25, LIST_MAX = 500;
  const transcript = [];           // {name, text, at}
  const remember = (name, text) => {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return;
    // Control commands addressed to this agent (`/<cmd> …`) and its replies to
    // them are lookup chatter, not room record — keep them out of the history.
    if (cmdRe.test(t)) return;
    transcript.push({ name, text: t.slice(0, 400), at: Date.now() });
    if (transcript.length > TRANSCRIPT_MAX) transcript.shift();
  };
  const realName = (n) => (typeof n === "string" && n.trim()) ? n.trim() : null;   // "" / blank ⇒ no name
  const nameOf = (id) => realName(peerNames.get(id)) ?? realName(known[id]?.name) ?? short(id);
  const hasName = (id) => !!(realName(peerNames.get(id)) ?? realName(known[id]?.name));
  games = createGameRecorder({
    stateDir, roomHex, observer: { peerId: identity.peerId, name: myName }, nameOf,
    // trust weights from the persisted groups.json if this agent (or a co-located
    // memory carrier under the same state dir) holds one with ratings; else null
    weightsProvider: () => trustWeightsFromGroups(path.join(args.persist === "" ? stateDir : (args.persist ?? stateDir), "rooms", roomHex, "groups.json"), trustLevels, groupHasRatings),
    log: (m) => console.log(`${TAG} ${m}`),
  });

  // ---- chaired deliberation (the single-leader `/<cmd> chair` mode) ----
  // The agent becomes the ONE neutral chair of a structured deliberation and walks the
  // room through six phases, recording a decision of record at closure. Best practice
  // (Jim's EIES finding): exactly one leader — a computer chair *or* a human leader,
  // never both (the two compete and stymie consensus). So when chairing, the agent IS
  // the single leader; `/<cmd> next` is a participant *readiness signal* the chair acts
  // on, not a second leader. Phase prompts/syntheses ride the un-throttled reply() path.
  const PHASES = ["define", "alternatives", "evaluate", "disagreements", "agreements", "closure"];
  const COLLECT_PHASES = PHASES.slice(0, 5);   // define..agreements gather input; closure finalizes
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const PHASE_PROMPT = {
    define: (topic) => `🪑 **Deliberation: ${topic}**\nPhase 1 — *define*: what exactly are we deciding, and what's in scope? I'll chair (one leader, best practice); you all deliberate. Anyone: \`/${CMD} next\` when ready · \`/${CMD} cancel\` to stop.`,
    alternatives: () => `Phase 2 — *alternatives*: what are the options? Put candidates on the table — no judging yet. \`/${CMD} next\` when ready.`,
    evaluate: () => `Phase 3 — *evaluate*: weigh the options — pros, cons, and the criteria that matter. \`/${CMD} next\` when ready.`,
    disagreements: () => `Phase 4 — *disagreements*: where do we genuinely disagree? Name the cruxes. \`/${CMD} next\` when ready.`,
    agreements: () => `Phase 5 — *agreements*: what do we agree on? Let's converge. \`/${CMD} next\` to close and record the decision.`,
  };
  let chair = null;   // { topic, phaseIdx, phase, startedAt, phaseStartedAt, collected:{phase:[{name,text}]}, synthesis:{phase:str} }
  const chairStatusSuffix = () => chair ? ` · 🪑 deliberation in progress: **${chair.topic}** (phase *${chair.phase}*, ${(chair.collected[chair.phase]?.length ?? 0)} notes) — \`/${CMD} next\` / \`/${CMD} close\` / \`/${CMD} cancel\`.` : "";

  // ---- trust-governed membership (PR B) ----
  // The agent is an ordinary trust-weighted member: the room governs its voice via
  // the SAME liquid-trust primitives as humans. It ingests gov envelopes, computes
  // its own standing, and applies Jim's rule — operate at ONE LEVEL BELOW its actual
  // rating, at full power for that capped level. Concretely a rated agent posts up to
  // `min(configured budget, trustLevel)` per window (= a same-rated human's weight
  // 1+level, minus the one-level dock), 0 if censure-discredited (stand down). With no
  // ratings in its groups it runs at the configured budget (back-compat). Ingesting
  // unverified gov envelopes only ever throttles the agent's OWN voice (never exceeds
  // the operator's --budget ceiling), and the ⅔ censure quorum blocks lone griefers.
  const groups = new Map();    // groupId -> Group model (from gov envelopes / sync-gov)
  let standing = { governed: false, budget: MAX_POSTS, level: null, discredited: false };
  function computeStanding() {
    let governed = false, level = null, discredited = false;
    for (const g of groups.values()) {
      if (!isMember(g, identity.peerId) || !groupHasRatings(g)) continue;
      governed = true;
      const lv = trustLevels(g)[identity.peerId] ?? 0;
      if (level === null || lv > level) level = lv;
      if (discreditedMembers(g).includes(identity.peerId)) discredited = true;
    }
    if (!governed) return { governed: false, budget: MAX_POSTS, level: null, discredited: false };
    const lv = level ?? 0;
    const budget = discredited ? 0 : Math.min(MAX_POSTS, lv);   // 1+effectiveLevel = lv; 0 ⇒ stand down
    return { governed: true, budget, level: lv, discredited };
  }
  function updateStanding() {
    const prev = standing;
    standing = computeStanding();
    if (prev.budget === standing.budget && prev.governed === standing.governed) return;
    console.log(`${TAG} standing: governed=${standing.governed} level=${standing.level ?? "-"} budget=${standing.budget}/5min${standing.discredited ? " (discredited)" : ""}`);
    if (prev.budget === 0 && standing.budget > 0) reply(`Thanks — I'm cleared to take part again (trust level ${standing.level}).`, "govstanding", 30_000);
    else if (prev.budget > 0 && standing.budget === 0) reply(standing.discredited ? `Understood — I've been censured, so I'll stand down (direct replies only). \`/gov trust\` me to restore.` : `I'm not vouched here yet, so I'll stay quiet until an admin \`/gov trust\`s me.`, "govstanding", 30_000);
  }
  function standingText() {
    if (!standing.governed) return `I'm not under room trust yet — running at my configured budget (${MAX_POSTS}/5min). An admin can \`/gov member add ${identity.peerId}\` then \`/gov trust\` me.`;
    if (standing.discredited) return `I've been censured here, so I've stood down (trust 0). \`/gov trust\` me to restore my voice.`;
    return `Room trust level ${standing.level} → I post up to ${standing.budget}/5min — one rung below a same-rated member (\`/gov trust\`/\`/gov censure\` to adjust).`;
  }

  // ---- multi-agent: which duties a peer's role performs; lead election ----
  const isAgentPeer = (id) => id === identity.peerId || agents.has(id);
  function dutiesForPeer(id) {
    if (id === identity.peerId) return role.duties;
    const rk = agents.get(id);
    return rk ? dutiesOf(rk) : null;       // null ⇒ not a known agent
  }
  // Among present agents that perform `duty` (incl. self), the lowest peerId leads.
  // `sameRoleOnly`: compete only with agents of MY role — used for self-introduction,
  // where a facilitator and a scribe should EACH announce themselves (different
  // content), but two facilitators should not double-announce.
  function isLead(duty, sameRoleOnly = false) {
    if (!role.duties[duty]) return false;
    const cands = [identity.peerId];
    for (const id of present) {
      if (id === identity.peerId) continue;
      const rk = agents.get(id);
      if (!rk) continue;                                  // not a known agent
      if (sameRoleOnly && rk !== roleKey) continue;       // only same-role peers compete
      if (dutiesOf(rk)[duty]) cands.push(id);
    }
    cands.sort();
    return cands[0] === identity.peerId;
  }
  const leadGate = (duty, sameRoleOnly = false) => role.duties[duty] && isLead(duty, sameRoleOnly);

  // ---- measured-disruption gate ----
  const postLog = [];
  const cooldown = new Map();
  let lastPostAt = 0;
  let muted = false;               // /<cmd> off → suppress nudges (replies still work)
  const withinBudget = () => { const now = Date.now(); while (postLog.length && now - postLog[0] > WINDOW_MS) postLog.shift(); return postLog.length < standing.budget; };
  const cooled = (key, ms) => Date.now() - (cooldown.get(key) ?? 0) >= ms;
  function purgeRolling() { const now = Date.now(); while (chatLog.length && now - chatLog[0].at > CHAT_RETAIN_MS) chatLog.shift(); while (recentMsgs.length && now - recentMsgs[0].at > CHAT_RETAIN_MS) recentMsgs.shift(); }
  function recentHumanCount(ms = ACTIVE_MS) { purgeRolling(); const now = Date.now(); return chatLog.filter((c) => now - c.at <= ms && !isAgentPeer(c.peer)).length; }
  // Collective agent footprint: my own recent posts + other agents' recent chats.
  function recentAgentPosts(ms = ACTIVE_MS) { const now = Date.now(); const mine = postLog.filter((t) => now - t <= ms).length; const others = chatLog.filter((c) => now - c.at <= ms && c.peer !== identity.peerId && agents.has(c.peer)).length; return mine + others; }
  function overFairShare() { const humans = recentHumanCount(); if (humans < 4) return false; return recentAgentPosts() >= Math.ceil(humans * 0.34); }
  function wouldPost(key, ms) { const now = Date.now(); if (now - lastPostAt < MIN_GAP_MS) return false; if (!withinBudget()) return false; if (key && !cooled(key, ms)) return false; if (overFairShare()) return false; return true; }
  function buildCtx() { const now = Date.now(); const silent = [...present].filter((id) => !isAgentPeer(id) && (now - (spokeAt.get(id) ?? 0)) > LULL_MS).map(nameOf); return { transcript: recentMsgs.slice(-20).map((m) => ({ name: m.name, text: m.text })), silent }; }
  function substantiveChat() { const now = Date.now(); const recent = chatLog.filter((c) => now - c.at <= ACTIVE_MS && !isAgentPeer(c.peer)); return recent.length >= 4 && new Set(recent.map((c) => c.peer)).size >= 2; }

  function say(text, key, cooldownMs = 0) {
    if (muted) { if (args.verbose) console.log(`${TAG} · held (muted): ${text}`); return false; }
    if (standing.budget === 0) { if (args.verbose) console.log(`${TAG} · held (trust stand-down): ${text}`); return false; }
    const now = Date.now();
    if (now - lastPostAt < MIN_GAP_MS) { if (args.verbose) console.log(`${TAG} · held (min-gap): ${text}`); return false; }
    if (!withinBudget())             { if (args.verbose) console.log(`${TAG} · held (budget): ${text}`); return false; }
    if (key && !cooled(key, cooldownMs)) return false;
    if (overFairShare())             { if (args.verbose) console.log(`${TAG} · held (fair-share): ${text}`); return false; }
    peer.broadcast({ kind: "chat", text });
    postLog.push(now); lastPostAt = now; if (key) cooldown.set(key, now);
    remember(myName, text);
    console.log(`${TAG} → ${text}`);
    return true;
  }

  // Direct replies to a user's query/command: bypass budget/min-gap/fair-share
  // (rate-limited only by a per-command cooldown) and work even when muted.
  function reply(text, key, cooldownMs = 30_000) {
    if (key && !cooled(key, cooldownMs)) return false;
    peer.broadcast({ kind: "chat", text });
    postLog.push(Date.now()); lastPostAt = Date.now(); if (key) cooldown.set(key, Date.now());
    // `ag*` keys are the fixed control replies (presence/help/trust/health/list/
    // mute) — pure lookup chatter, kept out of the room record. Substantive
    // replies (ask answers, chair syntheses; key null) are recorded.
    if (!key || !key.startsWith("ag")) remember(myName, text);
    console.log(`${TAG} ↩ ${text}`);
    return true;
  }

  // A 1:1 answer to one asker (like presenceReply/listReply below) — for
  // results that name the asker's own address/balance and don't belong
  // broadcast to the room. Falls back to a broadcast if there's no direct
  // route yet.
  function directReply(fromId, text) {
    if (fromId && peer.send(fromId, { kind: "chat", text })) {
      postLog.push(Date.now()); lastPostAt = Date.now();
      console.log(`${TAG} ↩ ${text}`);
    } else {
      reply(text, null, 0);
    }
  }

  const askHint = advisor.enabled ? "" : " (needs --ai)";
  const faucetHint = facilKey ? ` · \`/${CMD} faucet\` (sends ${FAUCET_REV} TEST REV to your own address, which your browser fills in; pass one to override — test systems only)` : "";
  const helpText = () => `I'm ${myName}, ${role.blurb} Commands: \`/${CMD}\` (am I here?) · \`/${CMD} help\` · \`/${CMD} ask <question>\`${askHint} · \`/${CMD} optimize <problem>\`${askHint} (facilitate an annealing-style optimization round) · \`/${CMD} chair <topic>\`${askHint} (chair a structured deliberation → define · alternatives · evaluate · disagreements · agreements · closure, then record the decision; \`/${CMD} next\`/\`back\`/\`close\`/\`cancel\` to steer) · \`/${CMD} start <label> [payoffs a,b,c,d] [stag=…] [hare=…] [predict: …]\` / \`/${CMD} stop\` (record a live game: every poll, estimate, lemma and message, timestamped and signed → a structured record; \`/${CMD} games\`, \`/${CMD} summarize\`${askHint}, \`/${CMD} publish\`) · \`/${CMD} list [n]\` (the room's screen history, oldest→newest — default 25, max 500) · \`/${CMD} trust\` (my standing) · \`/${CMD} health\` (uptime, peers, budget, CPU) · \`/${CMD} off\` / \`/${CMD} on\` (mute/unmute)${faucetHint}. I'm a full member — \`/gov trust\` me up or \`/gov censure\` me down. About this room (and how to make your own): ${ABOUT_URL}`;
  const statusText = () => `👋 Yes, I'm here — ${myName} (${role.name})${muted ? ` — currently muted (\`/${CMD} on\` to wake me)` : ""}.${standing.governed ? ` Trust ${standing.level}${standing.discredited ? " — stood down" : ` (≤${standing.budget}/5min)`}.` : ""} \`/${CMD} help\` · \`/${CMD} trust\`.`;
  const introText = () => `Hi — I'm ${myName}, ${role.blurb} Say \`/${CMD}\` or \`/${CMD} help\` to reach me${advisor.enabled ? `, or \`/${CMD} ask <q>\` to ask me anything` : ""}. I'm a full room member — \`/gov trust\`/\`/gov censure\` me; \`/${CMD} trust\` shows my standing. About this room: ${ABOUT_URL}`;
  // Self-introduce to a newly-identified human peer, once per peer per run (direct
  // message, so existing members aren't re-pinged each time someone joins).
  function introduceTo(id) {
    if (!role.duties.intro || muted || standing.budget === 0) return;
    if (isAgentPeer(id) || introduced.has(id) || !present.has(id)) return;
    if (!leadGate("intro", true)) { introduced.add(id); return; }   // a co-role agent leads
    if (peer.send(id, { kind: "chat", text: introText() })) { introduced.add(id); console.log(`${TAG} ↪ intro → ${nameOf(id)}`); }
  }
  // Test-system REV faucet (opt-in --key). A DETERMINISTIC action, never an
  // LLM-authorized one: both the dedicated `/<cmd> faucet` subcommand and the
  // NL "give me test rev" intercept in handleAsk below call this one function
  // — the advisor never gets a say in whether or how much REV moves. No rate
  // limit (by design, for a test system); the recipient address is either
  // given explicitly or recalled from `known[fromId].revAddress` (recorded the
  // first time it's given, so a later bare `/<cmd> faucet` just works).
  const REV_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{20,60}$/;   // base58 shape sanity check only
  async function handleFaucet(argText, fromId) {
    if (!facilKey) { directReply(fromId, `The test-REV faucet isn't configured on this agent (needs --key at startup) — ask whoever's running me.`); return; }
    const explicit = String(argText ?? "").trim().split(/\s+/)[0] ?? "";
    // A malformed EXPLICIT address is always an error — never silently fall
    // back to a stale address on file, which would look like the new one was
    // accepted when it was actually just ignored.
    if (explicit && !REV_ADDR_RE.test(explicit)) {
      directReply(fromId, `That doesn't look like a REV address — \`/${CMD} faucet\` on its own uses yours, or pass one explicitly.`);
      return;
    }
    const addr = explicit || (known[fromId]?.revAddress ?? "");
    if (!addr) {
      directReply(fromId, `I can send ${FAUCET_REV} test REV, but I have no address for you — a browser fills that in automatically, so this usually means no deploy key yet: \`/rholang key generate\`, then \`/${CMD} faucet\` on its own.`);
      return;
    }
    if (explicit && known[fromId]?.revAddress !== explicit) {
      (known[fromId] ??= { firstSeen: Date.now() }).revAddress = explicit;
      saveKnown();
    }
    directReply(fromId, `Sending ${FAUCET_REV} test REV to ${addr}… (may take a few seconds to confirm)`);
    try {
      const out = await faucetSend(addr);
      if (!out.ok) { directReply(fromId, `Deploy failed: ${out.message.slice(0, 300)}`); return; }
      // Say what is known, and never say something that reads as failure when
      // the transfer is simply still settling — that is what made people retry.
      if (out.confirmed) {
        directReply(fromId, `✅ Sent ${FAUCET_REV} test REV to ${addr} — your balance is now ${out.balance}.`);
      } else if (out.ran) {
        directReply(fromId, `✅ Sent ${FAUCET_REV} test REV to ${addr}. It is in a block and did not error, but my balance read has not caught up yet — it will arrive; no need to ask again. Check with \`$balance($me)\` (a \`/rholang eval\` under the hood, if you want to see the program).`);
      } else {
        directReply(fromId, `Deploy accepted for ${addr}, but no block carried it within my wait window. That is normal when the chain is quiet — it is queued, not lost, so please do not resend. \`$balance($me)\` will show it.`);
      }
    } catch (e) { directReply(fromId, `Faucet error: ${e?.message ?? e}`); }
  }
  // Intent phrases an ask-mode question routes here on, BEFORE the LLM ever
  // sees it — deterministic parsing, not an LLM deciding to move funds. An
  // address embedded in the question (e.g. "give me test rev to 1111abc…")
  // is pulled out the same way the dedicated command takes one.
  const FAUCET_INTENT_RE = /\b(test\s*rev|some\s+rev|free\s+rev|rev\s+faucet|faucet)\b/i;
  const REV_ADDR_IN_TEXT_RE = /\b[1-9A-HJ-NP-Za-km-z]{20,60}\b/;
  async function handleAsk(q, fromId) {
    if (!q) { reply(`Ask me anything about the room, my role, or decisions — \`/${CMD} ask <question>\`.`, "askhelp", 12_000); return; }
    if (FAUCET_INTENT_RE.test(q)) {
      const addrMatch = q.match(REV_ADDR_IN_TEXT_RE);
      await handleFaucet(addrMatch ? addrMatch[0] : "", fromId);
      return;
    }
    if (!advisor.enabled) { reply(`I'd need AI mode for that — start me with \`--ai\` (\`--ai-backend claude-code\` to use a Claude subscription, or set \`ANTHROPIC_API_KEY\`). For now, \`/${CMD} help\` lists what I do.`, "asknoai", 20_000); return; }
    if (!cooled("ask", 6_000)) return;
    cooldown.set("ask", Date.now());
    const text = await advisor.advise("ask", { question: q, transcript: recentMsgs.slice(-12).map((mm) => ({ name: mm.name, text: mm.text })) });
    reply(text || `Hmm, I don't have a good answer to that one. \`/${CMD} help\` for what I can do.`, null, 0);
  }
  // Facilitate one step of a collective-optimization round (the room as a quantum-
  // annealing-style optimizer). Stateless: re-reads the recent discussion each call,
  // proposes/refines candidates, and suggests the next scoring step (/estimate or
  // /poll → /probe → /lemma). See Collective_Optimization.md.
  async function handleOptimize(problem) {
    if (!problem) { reply(`Give me something to optimize — \`/${CMD} optimize <objective + constraints>\` (e.g. "pick a sprint plan: ship auth in 2 weeks, 2 engineers"). I'll propose candidates and a way to score them.`, "opthelp", 12_000); return; }
    if (!advisor.enabled) { reply(`I'd need AI mode for that — start me with \`--ai\` (\`--ai-backend claude-code\` for a Claude subscription, or set \`ANTHROPIC_API_KEY\`). For now, \`/${CMD} help\`.`, "optnoai", 20_000); return; }
    if (!cooled("optimize", 6_000)) return;
    cooldown.set("optimize", Date.now());
    const text = await advisor.advise("optimize", { problem, transcript: recentMsgs.slice(-16).map((mm) => ({ name: mm.name, text: mm.text })) });
    reply(text || `Hmm, I couldn't frame that one. Try \`/${CMD} optimize <objective + constraints>\`.`, null, 0);
  }

  // ---- game recording (`/<cmd> start … | stop | status | summarize | publish | games`) ----
  // The observer's commands. Recording is its own: every envelope this peer receives is
  // appended to the game's events file, so the record does not depend on any other agent.
  let lastSummary = null;   // { path, text, label }
  function handleGameStart(raw, fromId, fullText) {
    if (!raw) { reply(`Start recording a game — \`/${CMD} start <label> [payoffs a,b,c,d] [stag=<option text>] [hare=<option text>] [predict: … ; …]\`. What you type is the pre-registration: it is in the room record, timestamped and signed, before any round is played. \`/${CMD} stop\` when done.`, "gamehelp", 8_000); return; }
    const r = games.start(raw, { peerId: fromId ?? null, name: fromId ? nameOf(fromId) : null });
    if (!r.ok) { reply(`Not started — ${r.reason}. \`/${CMD} stop\` first.`, "gamebusy", 8_000); return; }
    // The start command is the pre-registration: make it the record's first event.
    games.record(fromId ?? "?", { kind: "chat", text: fullText ?? raw, preregistration: true });
    const sp = r.game.spec;
    const bits = [];
    if (sp.payoffs) {
      const { a, b, c, d } = sp.payoffs;
      const pd = a > d ? "S" : (d > a ? "H" : "tie"), rd = (a - c) > (d - b) ? "S" : ((d - b) > (a - c) ? "H" : "tie");
      const pstar = ((a - c) + (d - b)) !== 0 ? ((d - b) / ((a - c) + (d - b))) : null;
      bits.push(`payoffs a=${a} b=${b} c=${c} d=${d} → payoff-dominant ${pd}, risk-dominant ${rd}` + (pstar !== null ? `, basin threshold p*=${pstar.toFixed(2)}` : ""));
    }
    if (sp.stag || sp.hare) bits.push(`options: stag=${sp.stag ?? "?"} hare=${sp.hare ?? "?"}`);
    if (sp.predictions.length) bits.push(`pre-registered: ${sp.predictions.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`);
    reply(`🎯 Recording **${sp.label}**${bits.length ? " — " + bits.join("; ") : ""}. I'm only watching: polls, estimates, lemmas and chat go into the record as they happen. \`/${CMD} stop\` to close it.`, null, 0);
  }
  function handleGameStop() {
    const r = games.stop();
    if (!r.ok) { reply(`Nothing is being recorded. \`/${CMD} start <label>\` to begin.`, "gamenone", 8_000); return; }
    const rec = r.record;
    reply(`🛑 Recorded **${rec.label}**: ${rec.events} events, ${rec.polls.length} poll${rec.polls.length === 1 ? "" : "s"}, ${rec.estimates.length} estimate round${rec.estimates.length === 1 ? "" : "s"}, ${rec.lemmas.length} lemma${rec.lemmas.length === 1 ? "" : "s"}, ${Object.keys(rec.participants).length} participants` +
      (rec.polls.length ? ` — results: ${rec.polls.map((p) => `“${p.question.slice(0, 40)}” → ${p.tally.winners.join(" | ") || "(no ballots)"}${p.tally.weighted && p.tally.winnersWeighted.join("|") !== p.tally.winners.join("|") ? ` (trust-weighted: ${p.tally.winnersWeighted.join(" | ")})` : ""}`).join("; ")}` : "") +
      `. Record → \`games/${path.basename(r.game.recordPath)}\`${advisor.enabled ? `; \`/${CMD} summarize\` for the summary` : ""}.`, null, 0);
  }
  function gameStatusText() {
    const g = games.current;
    if (g) return `🎯 Recording **${g.spec.label}** since ${g.startedAt} — ${g.count} events so far. \`/${CMD} stop\` to close it.`;
    const idx = games.list();
    return idx.length ? `Not recording. ${idx.length} game${idx.length === 1 ? "" : "s"} on record (latest: **${idx[idx.length - 1].label}**, ${idx[idx.length - 1].events} events). \`/${CMD} games\` to list, \`/${CMD} start <label>\` to record.` : `Not recording, and no games on record yet. \`/${CMD} start <label>\` to begin.`;
  }
  function gamesListText() {
    const idx = games.list();
    if (!idx.length) return `No games recorded in this room yet.`;
    return `📚 Games recorded (${idx.length}):\n` + idx.slice(-20).map((e, i) => `${idx.length - Math.min(20, idx.length) + i + 1}. **${e.label}** ${e.startedAt.slice(0, 16).replace("T", " ")} — ${e.events} events, ${e.polls} polls, ${e.estimates} estimates, ${e.lemmas} lemmas → \`${e.file}\``).join("\n");
  }
  async function handleGameSummarize() {
    if (games.current) { reply(`Still recording **${games.current.spec.label}** — \`/${CMD} stop\` first, then summarize.`, "gamesumbusy", 8_000); return; }
    const latest = games.loadLatest();
    if (!latest) { reply(`No recorded game to summarize yet.`, "gamesumnone", 8_000); return; }
    if (!advisor.enabled) { reply(`I'd need AI mode to write the summary — start me with \`--ai\` (\`--ai-backend claude-code\` for a Claude subscription). The structured record is already on disk: \`${latest.entry.file}\`.`, "gamesumnoai", 20_000); return; }
    if (!cooled("gamesummary", 10_000)) return;
    cooldown.set("gamesummary", Date.now());
    reply(`✍️ Summarizing **${latest.record.label}** (${latest.record.events} events)…`, null, 0);
    const text = await advisor.advise("gamesummary", { record: compactForPrompt(latest.record) });
    if (!text) { reply(`Hmm, the summary didn't come back. The record is still on disk: \`${latest.entry.file}\`.`, null, 0); return; }
    const p = games.writeSummary(latest.record, text);
    lastSummary = { path: p, text, label: latest.record.label };
    console.log(`${TAG} game: summary → ${p}`);
    reply(`📝 Summary of **${latest.record.label}** written → \`${path.basename(p)}\` (not posted). \`/${CMD} publish\` to post it here, so the room can \`/lemma\` it if it stands behind it.`, null, 0);
  }
  function handleGamePublish() {
    if (!lastSummary) { reply(`No summary to publish — \`/${CMD} summarize\` first.`, "gamepubnone", 8_000); return; }
    reply(`📝 **Game summary — ${lastSummary.label}** (by ${myName}; the record it cites is on file, \`${path.basename(lastSummary.path)}\`)\n${lastSummary.text}`, null, 0);
  }

  // Begin a chaired deliberation: the agent becomes the single neutral chair (see the
  // chaired-deliberation note above). Walks define → alternatives → evaluate →
  // disagreements → agreements → closure, advancing on `/<cmd> next`, and records a
  // decision-of-record receipt at closure.
  async function handleChair(topic) {
    if (chair) { reply(`A deliberation is already in progress: **${chair.topic}** (phase *${chair.phase}*). \`/${CMD} status\`, \`/${CMD} next\`, \`/${CMD} close\`, or \`/${CMD} cancel\`.`, "chairbusy", 8_000); return; }
    if (!topic) { reply(`Start a facilitated deliberation — \`/${CMD} chair <topic or question>\`. I'll chair it through define → alternatives → evaluate → disagreements → agreements → closure, then record the decision. One leader (best practice): I chair, you all deliberate; \`/${CMD} next\` to move on.`, "chairhelp", 12_000); return; }
    if (!advisor.enabled) { reply(`I'd need AI mode to chair — start me with \`--ai\` (\`--ai-backend claude-code\` for a Claude subscription, or set \`ANTHROPIC_API_KEY\`).`, "chairnoai", 20_000); return; }
    chair = { topic: topic.slice(0, 200), phaseIdx: 0, phase: PHASES[0], startedAt: Date.now(), phaseStartedAt: Date.now(), collected: Object.fromEntries(COLLECT_PHASES.map((p) => [p, []])), synthesis: {}, busy: false };
    console.log(`${TAG} chair: started "${chair.topic}"`);
    reply(PHASE_PROMPT.define(chair.topic), null, 0);
  }
  // Synthesize the phase being left (neutral summary), post it, and stash it for closure.
  async function synthesizePhase(phase) {
    const collected = chair.collected[phase] ?? [];
    if (!collected.length) { chair.synthesis[phase] = "(nothing recorded)"; reply(`**${cap(phase)}** — nothing was recorded for this phase.`, null, 0); return; }
    const text = await advisor.advise("chair", { phase, topic: chair.topic, transcript: collected.map((m) => ({ name: m.name, text: m.text })) });
    const s = (text || "(no synthesis)").trim();
    chair.synthesis[phase] = s;
    reply(`**${cap(phase)}** — ${s}`, null, 0);
  }
  // Participant readiness signal → the one chair performs the transition. Guarded so a
  // fast double `/<cmd> next` (or next+close) can't race two async transitions and skip
  // a phase: while a synthesis/closure is mid-flight (`chair.busy`), further steps wait.
  const chairBusyReply = () => reply(`One moment — I'm still wrapping up *${chair.phase}*.`, "chairbusy2", 4_000);
  async function advanceChair() {
    if (!chair) { reply(`No deliberation in progress — start one with \`/${CMD} chair <topic>\`.`, "chairnone", 8_000); return; }
    if (chair.busy) { chairBusyReply(); return; }
    chair.busy = true;
    try {
      await synthesizePhase(chair.phase);
      if (chair.phaseIdx >= COLLECT_PHASES.length - 1) { await doClose(); return; }   // chair = null after
      chair.phaseIdx += 1; chair.phase = PHASES[chair.phaseIdx]; chair.phaseStartedAt = Date.now();
      reply(PHASE_PROMPT[chair.phase](chair.topic), null, 0);
    } finally { if (chair) chair.busy = false; }
  }
  function backChair() {
    if (!chair) { reply(`No deliberation in progress.`, "chairnone", 8_000); return; }
    if (chair.busy) { chairBusyReply(); return; }
    if (chair.phaseIdx === 0) { reply(`Already at the first phase (*define*).`, "chairback", 6_000); return; }
    chair.phaseIdx -= 1; chair.phase = PHASES[chair.phaseIdx]; delete chair.synthesis[chair.phase]; chair.phaseStartedAt = Date.now();
    reply(`↩ Reopening phase *${chair.phase}*. ${PHASE_PROMPT[chair.phase](chair.topic)}`, null, 0);
  }
  async function closeChair() {
    if (!chair) { reply(`No deliberation in progress — start one with \`/${CMD} chair <topic>\`.`, "chairnone", 8_000); return; }
    if (chair.busy) { chairBusyReply(); return; }
    chair.busy = true;
    try { await doClose(); } finally { if (chair) chair.busy = false; }
  }
  // Closure: produce a decision of record from the per-phase syntheses, post it, and
  // persist a receipt (the ZFA-closed record of the deliberation). Assumes chair set +
  // busy held by the caller.
  async function doClose() {
    const c = chair;
    // a direct `/<cmd> close` mid-phase still captures the current phase (skip if `next` already did)
    if (c.phase !== "closure" && !c.synthesis[c.phase] && (c.collected[c.phase]?.length)) await synthesizePhase(c.phase);
    const material = COLLECT_PHASES.filter((p) => c.synthesis[p]).map((p) => `${cap(p)}: ${c.synthesis[p]}`);
    const decisionText = await advisor.advise("chair", { phase: "closure", topic: c.topic, transcript: material.map((line) => ({ name: "", text: line })) });
    const decision = (decisionText || "(no decision recorded — too little input)").trim();
    c.synthesis.closure = decision;
    const ts = Date.now();
    const slug = c.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "topic";
    const receipt = { topic: c.topic, startedAt: c.startedAt, closedAt: ts, chair: identity.peerId, chairName: myName, phases: c.synthesis };
    try {
      const recPath = path.join(stateDir, "rooms", roomHex, "deliberations", `${ts}-${slug}.json`);
      writeJSON(recPath, receipt);
      const idxPath = path.join(stateDir, "rooms", roomHex, "deliberations.json");
      const idx = readJSON(idxPath, []); idx.push({ topic: c.topic, closedAt: ts, file: `deliberations/${ts}-${slug}.json` }); writeJSON(idxPath, idx);
      console.log(`${TAG} chair: recorded → ${recPath}`);
    } catch (e) { console.error(`${TAG} chair: receipt write failed:`, e?.message ?? e); }
    chair = null;
    reply(`✅ **Decision of record — ${c.topic}**\n${decision}\n_(recorded — \`/lemma\` to enter it as a room decision of record)_`, null, 0);
  }
  function cancelChair() {
    if (!chair) { reply(`No deliberation in progress.`, "chairnone", 8_000); return; }
    const t = chair.topic; chair = null;
    reply(`🛑 Deliberation **${t}** cancelled — nothing recorded.`, null, 0);
  }
  // ---- health / diagnostics (`/<cmd> health`) ----
  // A daemon that runs for weeks needs to answer "are you actually healthy?" from
  // inside the room, without shell access to the host. CPU is reported BOTH as a
  // lifetime average and as a delta since the previous check: a lifetime average
  // badly understates a runaway (that is exactly why `ps` %CPU hid the orphaned-SCTP
  // burn documented in CLAUDE.md), so the delta is the number that actually shows it.
  // High cpu here with a normal channel count is the signature to chase.
  const startedAt = Date.now();
  let cpuMark = process.cpuUsage(), cpuMarkAt = startedAt;
  let lastError = null, errorCount = 0;
  function noteError(what, e) {
    errorCount += 1;
    lastError = { what, msg: String(e?.message ?? e ?? "").slice(0, 160), at: Date.now() };
    console.error(`${TAG} ${what}:`, e?.message ?? e);
  }
  const dur = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
  };
  function healthText() {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const pct = (us, ms) => (ms > 0 ? (us / 1000 / ms) * 100 : 0).toFixed(1);
    const life = pct(cpu.user + cpu.system, now - startedAt);
    const dMs = now - cpuMarkAt;
    const since = dMs >= 5_000 ? `, ${pct((cpu.user - cpuMark.user) + (cpu.system - cpuMark.system), dMs)}% since last check` : "";
    cpuMark = cpu; cpuMarkAt = now;
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    purgeRolling();
    const roomFor = withinBudget();                    // also trims postLog to the live window
    const humans = [...present].filter((id) => !isAgentPeer(id)).length;
    const wsUp = peer.ws?.readyState === 1;            // 1 = WebSocket.OPEN
    const trust = standing.governed
      ? `level ${standing.level}${standing.discredited ? " — **discredited, stood down**" : ` (≤${standing.budget}/5min)`}`
      : `ungoverned (configured ${MAX_POSTS}/5min)`;
    const err = lastError
      ? `${errorCount} — last *${lastError.what}*: ${lastError.msg} (${dur(now - lastError.at)} ago)`
      : "none";
    return [
      `🩺 **Health — ${myName}** (${role.name})`,
      `· up ${dur(now - startedAt)} · rss ${rss} MB · cpu ${life}%${since}`,
      `· signaling ${wsUp ? "connected" : "**down / reconnecting**"} · channels ${peer.channels.size} · present ${present.size} (${humans} human, ${present.size - humans} agent) · known ${Object.keys(known).length}`,
      `· posts ${postLog.length}/${standing.budget} this 5min${roomFor ? "" : " — **budget spent**"} · min-gap ${Math.round(MIN_GAP_MS / 1000)}s · ${muted ? "**muted**" : "unmuted"}`,
      `· trust ${trust} · AI ${advisor.enabled ? advisor.model : "off"} · deliberation ${chair ? `**${chair.topic}** (${chair.phase})` : "none"}`,
      `· errors ${err}`,
    ].join("\n");
  }

  // The handlers below are fired from synchronous message dispatch and never awaited.
  // An unhandled rejection takes the whole daemon down under Node's default policy, so
  // a long-running agent records it for `/<cmd> health` and carries on instead.
  const bg = (p, what) => { Promise.resolve(p).catch((e) => noteError(what, e)); };

  function handleCommand(text, fromId) {
    const raw = String(text ?? "").trim();
    const lc = raw.toLowerCase();
    // "Am I here?" — bare `/facil`, `/facil status|here|ping`, or a no-slash
    // mention. A presence check is 1:1 ("tell ME you're there"), so answer the
    // asker DIRECTLY and essentially every time: a reply lost on a flaky channel
    // must not then be swallowed by a cooldown when they retry. Only a tight
    // repeat from the same asker (< 2s) is squelched. Direct-send falls back to
    // a broadcast if there is no route to the asker. NOT the verbose help text —
    // that is `/facil help`.
    const presenceReply = () => {
      const key = `agstatus:${fromId ?? "?"}`;
      if (!cooled(key, 2_000)) return true;
      cooldown.set(key, Date.now());
      const txt = statusText() + chairStatusSuffix();
      if (fromId && peer.send(fromId, { kind: "chat", text: txt })) {
        postLog.push(Date.now()); lastPostAt = Date.now();
        console.log(`${TAG} ↩ ${txt}`);
      } else {
        reply(txt, null, 0);   // no asker id or no route → broadcast
      }
      return true;
    };
    // `/<cmd> list [n]` — the room's screen history, oldest→newest, n in [1,500]
    // (default 25). A direct answer to the asker (like a presence check), so a
    // long dump doesn't fill the room; falls back to a broadcast with no route.
    const listReply = () => {
      const key = `aglist:${fromId ?? "?"}`;
      if (!cooled(key, 2_000)) return;
      cooldown.set(key, Date.now());
      const nRaw = parseInt((raw.match(/\b(?:list|log|history|transcript)\s+(\d+)/i) ?? [])[1] ?? "", 10);
      const n = Math.min(Number.isFinite(nRaw) && nRaw > 0 ? nRaw : LIST_DEFAULT, LIST_MAX);
      const total = transcript.length;
      if (!total) { reply("📜 nothing recorded yet this session.", null, 0); return; }
      const slice = transcript.slice(-n);
      const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
      let lines = slice.map((e) => `${hhmm(e.at)} ${e.name}: ${e.text}`);
      // Stay under the signaling payload cap; drop oldest lines if the dump is huge.
      let dropped = 0;
      while (lines.join("\n").length > 55_000 && lines.length > 1) { lines.shift(); dropped++; }
      const head = `📜 last ${slice.length - dropped} of ${total} line${total === 1 ? "" : "s"}` +
        (dropped ? ` (${dropped} more trimmed to fit)` : "") + (n < total && !dropped ? `  ·  \`/${CMD} list ${Math.min(total, LIST_MAX)}\` for more` : "") + ":";
      const txt = head + "\n" + lines.join("\n");
      if (fromId && peer.send(fromId, { kind: "chat", text: txt })) {
        postLog.push(Date.now()); lastPostAt = Date.now();
        console.log(`${TAG} ↩ [list ${slice.length} lines → ${short(fromId)}]`);
      } else {
        reply(txt, null, 0);
      }
    };

    const m = cmdRe.exec(lc);
    if (m) {
      const sub = m[1] ?? "";
      if (sub === "off" || sub === "mute" || sub === "quiet") { muted = true; reply(`Muted — I'll stay quiet. Say \`/${CMD} on\` to bring me back.`, "agmute", 0); return true; }
      if (sub === "on" || sub === "unmute" || sub === "wake") { muted = false; reply(`Back on 👋 — \`/${CMD} help\` for what I do.`, "agmute", 0); return true; }
      if (role.name === "observer" && (sub === "status" || sub === "here" || sub === "ping" || sub === "")) { reply(gameStatusText(), "agstatus", 3_000); return true; }
      if (sub === "" || sub === "status" || sub === "here" || sub === "ping") return presenceReply();
      if (sub === "trust" || sub === "standing") { reply(standingText(), "agtrust", 15_000); return true; }
      if (sub === "health" || sub === "diag" || sub === "diagnostics") { reply(healthText(), "aghealth", 15_000); return true; }
      if (sub === "list" || sub === "log" || sub === "history" || sub === "transcript") { listReply(); return true; }
      if (sub === "ask") { bg(handleAsk(raw.replace(askStripRe, "").trim(), fromId), "ask"); return true; }
      if (sub === "faucet" || sub === "testrev") { bg(handleFaucet(raw.replace(faucetStripRe, "").trim(), fromId), "faucet"); return true; }
      if (sub === "optimize" || sub === "opt") { bg(handleOptimize(raw.replace(optStripRe, "").trim()), "optimize"); return true; }
      if (sub === "chair" || sub === "deliberate") { bg(handleChair(raw.replace(chairStripRe, "").trim()), "chair"); return true; }
      if (sub === "next" || sub === "advance") { bg(advanceChair(), "chair next"); return true; }
      if (sub === "back") { backChair(); return true; }
      if (sub === "close" || sub === "decide") { bg(closeChair(), "chair close"); return true; }
      if (sub === "cancel" || sub === "abort") { cancelChair(); return true; }
      if (sub === "start" || sub === "record" || sub === "begin") { handleGameStart(raw.replace(gameStartStripRe, "").trim(), fromId, raw); return true; }
      if (sub === "stop" || sub === "end") { handleGameStop(); return true; }
      if (sub === "games" || sub === "recorded") { reply(gamesListText(), "aggames", 5_000); return true; }
      if (sub === "summarize" || sub === "summary") { bg(handleGameSummarize(), "game summarize"); return true; }
      if (sub === "publish") { handleGamePublish(); return true; }
      reply(helpText(), "aghelp", 15_000); return true;   // `/facil help` and any unknown subcommand
    }
    if (bareNameRe.test(lc) || anyoneHereRe.test(lc)) return presenceReply();
    // bare greeting → only the lead greet-capable agent replies (so N agents don't all say hi)
    if (greetingRe.test(lc)) {
      if (leadGate("greet")) { reply(`👋 Hi! I'm ${myName}, the room ${role.name} — \`/${CMD} help\` for what I do.`, "aggreet", Math.round(4 * 60_000 * scale)); return true; }
      return false;
    }
    return false;
  }

  // ---- the room's memory, if this agent is carrying it ----
  //
  // A room is p2p: its state lives in the browsers in it and dies with the last
  // one. --persist makes this agent the peer that keeps it — the same duty
  // qos-daemon.mjs performs alone, folded in here so it costs no extra peer
  // against the signaling server's room-size ceiling (see run-agents.sh).
  //
  // Deliberately NOT gated on lead election: duties like greeting are lead-only
  // so N agents don't all greet at once, but state must be served by whoever
  // holds it, every time, or a joiner gets nothing.
  const memDir = args.persist === "" ? stateDir : args.persist;
  let mem = null;
  const signedKinds = memDir ? PERSIST_SIGNED_KINDS : SIGNED_KINDS;

  const peer = new QOSPeer({
    signalingUrl: args.signal, roomId, peerId: identity.peerId,
    // The agent never needs TURN for itself — it is data-only (it rejects call
    // media) and its data reaches any peer over the flood relay. Fetching a
    // relay only adds relay ICE candidates that get trickled through the
    // (metered) signaling server on every handshake. Opt in with --turn if this
    // agent must hold a direct link across a NAT boundary for the relay to work.
    noAutoTurn: !args.turn,
    onSignalingOpen: () => console.log(`${TAG} signaling connected; joined room`),
    onSignalingClose: (code, reason) => console.warn(
      `${TAG} signaling dropped` + (code ? ` (${code}${reason ? " " + reason : ""})` : "")),
    onReconnectScheduled: (ms) => console.warn(`${TAG} reconnecting in ${(ms / 1000).toFixed(1)}s`),
    onPeerJoined: (id) => { if (args.verbose) console.log(`${TAG} ${short(id)}… joining`); },
    onPeerLeft: (id) => { present.delete(id); introduced.delete(id); agents.delete(id); nameAnnouncedAt.delete(id); mem?.forgetPeer?.(id); },
    onError: (e) => noteError("peer", e),
    onChannelOpen: (id) => { onChannelOpen(id); mem?.serveStateTo(id); },
    onMessage: (from, d) => { onMessage(from, d); void mem?.ingest(from, d); },
  });

  let signQueue = Promise.resolve();
  function signedSend(target, env) {
    signQueue = signQueue.then(async () => {
      const out = { ...env };
      if (signedKinds.has(env.kind)) { try { out.dyncap = await signEnvelope(dyncapState, roomId, env); saveIdentity(); } catch (e) { console.error(`${TAG} sign failed:`, e?.message ?? e); } }
      peer.send(target, out);
    }).catch((e) => console.error(`${TAG} send error:`, e?.message ?? e));
    return signQueue;
  }

  // Our identity announcement, signed ONCE and cached so re-announces are byte-
  // identical re-deliveries (the browser treats an identical anchor+seq+witness as
  // idempotent, so resending never advances the seq or forks the chain). The single
  // channel-open announce can be lost when signaling is flapping — the sign is async,
  // and the data channel can close in that window — leaving a fresh browser with no
  // name for us at all. `announceName` is therefore also re-fired from the tick loop
  // (throttled per peer) so a dropped announcement self-heals instead of the agent
  // showing as an unlabelled hex id until the next full reconnect.
  const nameAnnouncedAt = new Map();          // peerId -> last announce ms
  let signedNameEnv = null;
  async function announceName(id) {
    if (!signedNameEnv) {
      const env = { kind: "name", name: myName, agent: roleKey };
      try { env.dyncap = await signEnvelope(dyncapState, roomId, env); saveIdentity(); }
      catch (e) { console.error(`${TAG} sign failed:`, e?.message ?? e); }
      signedNameEnv = env;
    }
    if (peer.send(id, signedNameEnv)) nameAnnouncedAt.set(id, Date.now());
  }
  const ANNOUNCE_TTL = 90_000;                // re-announce a present peer at most this often
  function reannounceStale() {
    const now = Date.now();
    for (const id of present) {
      if (now - (nameAnnouncedAt.get(id) ?? 0) > ANNOUNCE_TTL) bg(announceName(id), "announce");
    }
  }

  function onChannelOpen(id) {
    if (id === identity.peerId) return;
    present.add(id);
    joinedAt.set(id, Date.now());
    // announce name + our agent role so other agents recognize us (self-heals via
    // reannounceStale if this delivery is lost to a signaling flap)
    bg(announceName(id), "announce");
    // Self-introduction is delivered per-peer when a human identifies (see introduceTo,
    // called from onMessage) — NOT a one-time startup broadcast — so a browser that joins
    // later, or whose channel opens after a co-agent's, still reliably gets it.
    if (role.duties.greet) {
      const rec = (known[id] ??= { firstSeen: Date.now() });
      if (!rec.greeted) scheduleGreet(id, 0);
    }
  }

  const GREET_RETRIES = 4;
  function scheduleGreet(id, attempt) {
    const delay = attempt === 0 ? GREET_DELAY_MS + 1500 : MIN_GAP_MS + 2000;
    setTimeout(() => {
      const rec = known[id];
      if (!rec || rec.greeted || !present.has(id) || agents.has(id)) return;   // don't greet other agents
      if (!leadGate("greet")) { rec.greeted = Date.now(); saveKnown(); return; } // another agent leads greeting
      if (say(`👋 Welcome, ${nameOf(id)}! Jump in any time — what brings you here?`, `greet:${id}`, CD.greet)) { rec.greeted = Date.now(); saveKnown(); }
      else if (attempt < GREET_RETRIES) scheduleGreet(id, attempt + 1);
    }, delay);
  }

  function maybeNamePrompt(id) {
    if (!leadGate("namePrompt") || agents.has(id)) return;
    const rec = (known[id] ??= { firstSeen: Date.now() });
    if (rec.namePrompted || hasName(id)) return;
    if (say(`(psst ${short(id)}… — set a name with \`/name\` so everyone knows who's talking 🙂)`, `name:${id}`, CD.name)) { rec.namePrompted = Date.now(); saveKnown(); }
  }

  function onMessage(from, d) {
    if (from === identity.peerId || !d || typeof d !== "object") return;
    games?.record(from, d);
    if (args.verbose) console.log(`${TAG} ⇐ ${short(from)}… ${JSON.stringify(d).slice(0, 160)}`);
    switch (d.kind) {
      case "name":
        if (typeof d.name === "string") { peerNames.set(from, d.name); mem?.setPeerName(from, d.name); const r = (known[from] ??= { firstSeen: Date.now() }); r.name = d.name; saveKnown(); }
        // Keep a direct link to every other agent regardless of ring
        // position — matches the browser side (app.ts's own name handler).
        // Not required for correctness (broadcasts still reach everyone via
        // relay), but keeps agent-to-agent coordination (lead election,
        // trust sync) at one hop rather than however many the room's ring
        // happens to put between two agents.
        if (typeof d.agent === "string") { agents.set(from, d.agent.toLowerCase()); peer.pinNeighbor(from); }
        else peer.unpinNeighbor(from);
        introduceTo(from);   // a human just identified → self-introduce (skips agents/dups)
        if (!isAgentPeer(from) && !hasName(from)) setTimeout(() => maybeNamePrompt(from), 3_000);   // joined nameless → prompt
        break;
      case "chat": {
        spokeAt.set(from, Date.now());
        chatLog.push({ peer: from, at: Date.now() });
        recentMsgs.push({ name: nameOf(from), text: String(d.text ?? "").slice(0, 280), at: Date.now() });
        remember(nameOf(from), d.text);
        if (args.verbose) console.log(`[${nameOf(from)}] ${String(d.text).slice(0, 120)}`);
        introduceTo(from);   // covers a human who chats before announcing a name
        if (handleCommand(d.text, from)) break;
        // collect normal chat into an active chaired deliberation (skip agents + slash-commands)
        if (chair && !isAgentPeer(from)) {
          const txt = String(d.text ?? "");
          if (!txt.trim().startsWith("/")) (chair.collected[chair.phase] ??= []).push({ name: nameOf(from), text: txt.slice(0, 280) });
        }
        if (!isAgentPeer(from) && !hasName(from)) setTimeout(() => maybeNamePrompt(from), 2_000);
        checkDominator();
        break;
      }
      case "state-discrepancy": bg(surfaceDiscrepancy(d), "discrepancy"); break;
      // Twist-bearing claims the room is about to build on — see checkClaim.
      case "qlf": {
        const lines = Array.isArray(d.lines) ? d.lines.join(" · ") : "";
        remember(nameOf(from), `/${d.cmd ?? "?"}${d.arg ? " " + d.arg : ""}${lines ? " → " + lines : ""}`);
        if (d.cmd === "qlf-action" || d.cmd === "zfa-check") {
          checkClaim(parseTwists(String(d.arg ?? "").trim()), d.cmd === "qlf-action" ? "proposal" : "history");
        }
        break;
      }
      case "lemma":
        if (typeof d.twists === "string") checkClaim(parseTwists(d.twists), `lemma @${String(d.name ?? "").slice(0, 40)}`);
        break;
      // governance ingestion → recompute the agent's own trust standing (self-throttle only)
      case "group-open":
        if (d.id && !groups.has(d.id)) groups.set(d.id, normalizeGroup({ id: d.id, name: d.name, creator: from, creatorLabel: d.creatorLabel ?? short(from), createdAt: d.createdAt, members: { [from]: { peerId: from, role: "admin", label: d.creatorLabel ?? short(from), at: d.createdAt ?? Date.now() } } }));
        updateStanding();
        break;
      case "group-member": {
        const g = groups.get(d.groupId);
        if (g && d.peerId) {
          if (d.remove) delete g.members[d.peerId];
          else g.members[d.peerId] = { peerId: d.peerId, role: d.role === "admin" ? "admin" : "member", label: d.label ?? short(d.peerId), at: Date.now() };
          updateStanding();
        }
        break;
      }
      case "gov-trust": {
        const g = groups.get(d.groupId);
        if (g && d.rater && d.ratee && typeof d.rating === "number") {
          (g.trustRatings ??= {})[d.rater] ??= {};
          if (d.rating > 0) g.trustRatings[d.rater][d.ratee] = d.rating; else delete g.trustRatings[d.rater][d.ratee];
          updateStanding();
        }
        break;
      }
      case "gov-censure": {
        const g = groups.get(d.groupId);
        if (g && d.censurer && d.target) {
          (g.censures ??= {})[d.censurer] ??= {};
          if (d.on) g.censures[d.censurer][d.target] = 1; else delete g.censures[d.censurer][d.target];
          updateStanding();
        }
        break;
      }
      case "sync-gov":
        if (Array.isArray(d.groups)) { for (const g of d.groups) if (g && g.id) groups.set(g.id, normalizeGroup(g)); updateStanding(); }
        break;
    }
  }

  async function surfaceDiscrepancy(d) {
    if (!leadGate("discrepancy")) return;
    const key = `disc:${d.storeName}:${d.key}`;
    const label = d.key ?? d.storeName ?? "that";
    if (d.winner == null) {
      if (advisor.enabled && wouldPost(key, CD.discrepancy)) {
        const text = await advisor.advise("synthesize", buildCtx());
        if (text && say(text, key, CD.discrepancy)) return;
      }
      say(`We don't have consensus on **${label}** yet — want to deliberate it, or defer and record it as unresolved?`, key, CD.discrepancy);
    } else say(`Looks like we've converged on **${label}**. Want me to flag it so someone can record the decision (\`/lemma\`)?`, key, CD.discrepancy);
  }

  // ---- verifier duty (skeptic): which predicate did that history actually pass? ----
  //
  // The room's `achieves_zfa` conjoins Pauli closure with the AGGREGATE count
  // (count_pos == count_neg), where QLF's `is_zfa` wants PAIRWISE balance — the signed
  // action vector vanishing, which is what Zero Free Action names. The aggregate
  // predicate over-accepts, so a history can read "ZFA ✓" in the room and not be a QLF
  // closure at all. At length 6 that is 20,480 admitted against QLF's 5,120: three out
  // of four "closures" the room accepts are not closures under the census.
  //
  // That is a claim the group is about to build on, it is checkable from the twists
  // alone, and nothing else in the room says it — which makes it the skeptic's job
  // exactly: name the unexamined assumption, once, with the number attached.
  const flagged = new Set();          // histories already flagged, so we say it once
  function checkClaim(tw, what) {
    if (!role.duties.verify || !leadGate("verify")) return;
    if (!tw || tw.length < 2) return;
    // Only the gap is interesting. A history that fails both predicates is already
    // visibly not closed, and one that passes both needs no comment.
    if (!achievesZfa(tw) || achievesZfaPairwise(tw)) return;
    const key = `${what}:${[...tw].join("")}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    const action = signedAction(tw);
    const off = ["^/v", ">/<", "//\\", "+/-"].filter((_, i) => action[i] !== 0);
    const c = CENSUS_ADMITTED[tw.length];
    const scale = c && c.aggregate
      ? ` At length ${tw.length} the room's predicate admits ${c.aggregate.toLocaleString()} histories where QLF admits ${c.pairwise.toLocaleString()}.`
      : "";
    say(`⚖️ Worth a second look before we build on that ${what}: it passes the room's ZFA check, but not QLF's. `
      + `The room checks *aggregate* count balance; QLF wants every conjugate pair balanced on its own, and here `
      + `the signed action is (${action.join(", ")}) — ${off.join(" and ")} ${off.length > 1 ? "are" : "is"} off.`
      + scale, "verify", CD.verify);
  }

  function checkDominator() {
    if (!leadGate("dominator")) return;
    const now = Date.now();
    const recent = chatLog.filter((c) => now - c.at <= ACTIVE_MS && !isAgentPeer(c.peer));
    if (recent.length < DOMINATE_MIN) return;
    const by = new Map();
    for (const c of recent) by.set(c.peer, (by.get(c.peer) ?? 0) + 1);
    if (by.size < 3) return;
    let top = null, topN = 0;
    for (const [p, n] of by) if (n > topN) { top = p; topN = n; }
    if (topN / recent.length > DOMINATE_FRAC) say(`Lots of good thinking from ${nameOf(top)} — let's make space for other voices too. What do the rest of you make of it?`, "dominate", CD.dominate);
  }

  async function tick() {
    reannounceStale();   // self-heal any identity announcement lost to a signaling flap
    const humans = recentHumanCount();
    if (advisor.enabled) {
      const now = Date.now();
      const lastHuman = (() => { for (let i = chatLog.length - 1; i >= 0; i--) if (!isAgentPeer(chatLog[i].peer)) return chatLog[i].at; return 0; })();
      if (role.duties.synthesize && substantiveChat() && leadGate("synthesize") && wouldPost("synthesize", CD.synthesize)) {
        const text = await advisor.advise("synthesize", buildCtx());
        if (text) say(text, "synthesize", CD.synthesize);
      }
      if (role.duties.stimulate && lastHuman && now - lastHuman > LULL_MS && recentHumanCount(10 * 60_000) >= 3 && leadGate("stimulate") && wouldPost("stimulate", CD.stimulate)) {
        const text = await advisor.advise("stimulate", buildCtx());
        if (text) say(text, "stimulate", CD.stimulate);
      }
      return;
    }
    if (!role.duties.silentQuarter || !leadGate("silentQuarter")) return;
    if (humans < 2) return;
    const now = Date.now();
    const quiet = [...present].filter((id) => !isAgentPeer(id) && (now - (joinedAt.get(id) ?? now)) > SILENT_MS && (now - (spokeAt.get(id) ?? 0)) > SILENT_MS);
    if (!quiet.length) return;
    const names = quiet.slice(0, 2).map(nameOf).join(", ");
    say(`We haven't heard from everyone — ${names}, curious what you're thinking on this?`, "silent", CD.silent);
  }
  const timer = setInterval(() => tick().catch((e) => noteError("tick", e)), TICK_MS);

  if (memDir) {
    mem = openRoomMemory({
      roomId, stateDir: memDir, myName,
      signedSend: (t, e) => signedSend(t, e),
      log: (m) => console.log(`${TAG} ${m}`),
      warn: (m) => console.warn(`${TAG} ${m}`),
      verbose: args.verbose,
      // announceName already sends ours, and it carries `agent: <role>` — the
      // field the browser badges as an AI peer, and drops the badge without.
      serveName: false,
    });
    console.log(`${TAG} carrying room memory — ${mem.summary()} loaded  state=${memDir}`);
  }

  peer.connect();
  console.log(`${TAG} running as "${myName}" [role=${role.name}]  budget=${MAX_POSTS}/5min  min-gap=${Math.round(MIN_GAP_MS / 1000)}s  silent=${Math.round(SILENT_MS / 60000)}min  AI=${advisor.enabled ? advisor.model : "off"}. Ctrl-C to stop.`);

  let faucetHttp = null;
  if (args.faucetHttp !== undefined) {
    faucetHttp = createFaucetServer({ send: faucetSend, amount: FAUCET_AMOUNT, amountRev: FAUCET_REV, fundingAddress: facilAddr, rnode: rnodeUrl, log: (m) => console.log(`${TAG} ${m}`) }).server;
    faucetHttp.listen(args.faucetHttp, () => console.log(`${TAG} faucet HTTP on :${args.faucetHttp} — POST /faucet {"address"} · GET /health`));
    faucetHttp.on("error", (e) => { console.error(`${TAG} faucet HTTP failed: ${e?.message ?? e}`); process.exit(1); });
  }
  const shutdown = () => { console.log(`\n${TAG} shutting down…`); try { faucetHttp?.close(); } catch {} try { if (games?.current) games.stop(); } catch {} try { clearInterval(timer); saveIdentity(); saveKnown(); mem?.flush(); } catch {} try { peer.disconnect(); } catch {} setTimeout(() => process.exit(0), 200); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// CLI entry — only when invoked directly (not when imported by facilitator.mjs).
let invokedDirectly = false;
try { invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (invokedDirectly) run(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
