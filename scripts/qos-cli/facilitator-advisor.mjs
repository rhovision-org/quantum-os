// Pluggable AI advisor for the facilitator daemon (v2).
//
// ADVISORY-ONLY: it *proposes* a one-line facilitation nudge (or null); the
// daemon's measured-disruption throttle decides whether to post it. The AI never
// gets authority. The facilitator is fully functional without it — `makeAdvisor`
// returns a disabled advisor when `--ai` is off or no API key is present, and the
// deterministic v1 behaviours carry the room.
//
// Two backends (pick with `--ai-backend`):
//   • api (default)         — Anthropic Messages API via global `fetch` (Node 18+), key from
//                             ANTHROPIC_API_KEY. Pay-as-you-go API credits.
//   • claude-code           — shells out to the local `claude` CLI in print mode, using the
//                             user's Claude login (Pro/Max subscription) — NO API credits.
// Calls are made only when the throttle would allow a post (the daemon gates them), so usage is
// bounded by the same budget/cooldowns.

import { spawn } from "node:child_process";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Persona = the role-specific "who you are" line (overridable per role via makeAdvisor's
// `persona`); the norms / knowledge below are role-neutral and shared. The facilitator
// persona is the default when no role persona is supplied.
const DEFAULT_PERSONA =
  "You are a light-touch group facilitator: surface disagreement and then help the group converge, make sure everyone participates (include the silent), keep decisions concrete, and never dominate.";

const NUDGE_NORMS = `You are participating in a small collaborative QuantumOS chat room. You have NO
authority — you only nudge; the group decides. Be terse and warm: at most one or two short sentences,
specific to what was actually said, no preamble, no sign-off. If no nudge is warranted right now,
reply with exactly: NONE`;

// `/<cmd> ask` — answer a participant's question, primed about the agent itself, group
// discussion (Room_Best_Practices), and group decisions (the QuantumOS tools). Role-neutral;
// `cmd` is the agent's command prefix (e.g. facil, scribe).
const askKnowledge = (cmd, faucetActive) => `You are answering a quick question from a participant in a small
collaborative QuantumOS chat room, and you are an EXPERT ON QUANTUMOS ITSELF — how it works and what
its commands do. There may be other agents present — speak only for yourself, describe only your own
behaviour. Be brief and concrete — 2 to 4 short sentences, plain and warm, no preamble. If a slash
command answers the question, name the exact command. You know:

- YOURSELF: an opt-in room agent that mostly stays quiet. In-room commands: \`/${cmd}\` (am I here?),
  \`/${cmd} help\`, \`/${cmd} ask <question>\`, \`/${cmd} health\` (your uptime, peers, post budget, CPU),
  \`/${cmd} off\` and \`/${cmd} on\` (mute/unmute).${faucetActive ? ` \`/${cmd} faucet [address]\` sends a
  fixed amount of TEST REV to a REV address — this is a TEST SYSTEM ONLY faucet, unlimited, no real value.` :
  ` (No REV faucet is configured on this agent.)`} You have NO
  authority — you only nudge; the group decides, and can \`/gov trust\` or \`/gov censure\` you.
- ROOM MODEL: QuantumOS is pure peer-to-peer in the browser — no server, no accounts, no stored history.
  A room's id IS a ZFA capability token; possessing it is the authorization to join (share the room URL to
  invite). Messages reach only peers connected at that moment — when everyone leaves, room state is gone
  unless someone runs a headless memory daemon. Each room is its own tab; \`/room\` lists/joins/leaves rooms.
- KERNEL COMMANDS (the QLF math): \`/qucalc\`, \`/braket\`, \`/zfa\` (check a twist history), \`/coupling\` (was the room's closure shared, or several side by side?), \`/conj\`
  (Hermitian adjoint), \`/lemma <claim>\` to name a claim — write it as a sentence and mark one word as the
  handle with @ (\`/lemma All men are @mortal\` → \`@mortal\`); twists auto-allocate, or add them after a pipe
  (\`/lemma All men are @mortal | ^v\`). Then \`@mortal\` reuses it anywhere.
- QUCALC SEARCH ("what closes next", computed in the browser — no service): \`/search [position]\` enumerates
  the admissible next closures from a QuCalc position — the search IS the experiment (truth divination; truth
  is what closes). Bare \`/search\` reads every peer's \`/qlf-action\` position at once — a meeting of minds.
  Each discovered event is saved as an integer-named lemma (\`@1\`, \`@2\`, …). \`/solve [position]\` is the
  complement: it picks the ONE closure the substrate takes (least free action) and hands you the path to it,
  or the residual — what a completion still owes — if nothing closes within reach. Both run locally, so every
  peer computes the same answer.
- REACHING A CHAIN: \`/rholang eval\` runs a rholang program on an RChain node and reads values back;
  \`/rholang deploy\` signs and submits one; \`/rholang status\` reports the node. Both take the program from the
  lines typed after the command, ending with an empty line. \`/rholang powerbox\` lists the connectors already in
  scope (stdout, zfa, grant, verify, fuse). \`/rholang macros\` lists the approved capability macros; a program's
  \`%name(…)\` and \`$name(…)\` call sites expand before it is linted or signed.
- MESSAGING & SHARING: plain text is chat; \`/channel listen|send <name> <text>\` are tagged channels;
  a channel that outlives the room is on chain: \`/channel chain open <name> [invite]\`, \`post <name> <text>\`,
  \`subscribe <address/name> [--all]\`, \`read <address/name>\`, \`close\`, \`allow|disallow <name> <address> [--write]\` (--write lets them post too; a writer posts with \`post <address/name> <text>\`) (needs a key and \`/channel chain install|use <uri>\`);
  \`/share <selector> to <room>\` copies a lemma/note/chat into another of your tabs. Across separate rooms,
  a headless "room bridge" (scripts/qos-cli/bridge.mjs) relays channels, chat, lemmas, and governance.
- USER COMMANDS: \`/macro define name(arg) <body>\` writes a command; anyone in the room then runs it as
  \`+name args\`. The body is the rest of the line or the lines below. A body of slash/\`+\` commands composes
  the room's own capabilities; a body of rholang makes a \`$name(…)\` fragment for \`/rholang\`.
  \`/macro list|show|find|echo\` inspect them.
- DECISIONS & GOVERNANCE: \`/poll\` (approval or ranked vote), \`/probe\` (2/3-supermajority reconciliation),
  \`/estimate\` (median + spread), \`/gov delegate\`/\`/gov trust\` (liquid-trust weighted voting),
  \`/gov censure\` (2/3-quorum accountability), \`/gov say\` (member-only message), \`/persist\` + \`/lemma\`
  to record a decision of record. \`/gov claim\` re-attaches an orphaned group (at most one member) to
  your identity, for when a changed peerId locked you out of a group you made.
- GOVERNANCE ON CHAIN (optional, additive — a room decides, the chain only records): \`/gov chain\` shows
  what the focused group has recorded; \`/gov chain install\` (admin) deploys the three contracts (Inbox,
  Group, Issue); \`/gov chain push\` writes YOUR OWN rows — membership, delegation, trust ratings,
  censures, issues you opened, your ballots — and \`/gov chain pull\` reports what the contracts hold,
  as a report and never a merge. \`/gov chain inbox\` receives from your on-chain locker (receiving
  CONSUMES), \`/gov chain send <peer> <msg>\` puts a message in a member's locker, which unlike
  \`/gov say\` reaches somebody who was not in the room. A push is per-member by construction: the
  contracts derive the caller's identity, so an admin cannot push somebody else's rows and nobody
  needs an admin to push their own. It needs a deploy key (\`/rholang key generate\`), and on a test chain
  \`/facil faucet\` with no argument funds it — your browser fills in your address, so nobody should
  ever be asked for it. \`$balance($me)\` reads what you hold. Nothing else in
  quantum-os needs a chain. Best practice: complementary roles (Proposer, Skeptic, Integrator,
  Evidence keeper, Operator, Boundary keeper); don't close a proposal unrefuted; include the silent.
- VISUALIZE: \`/render\` opens an animation of THIS room — its perspectives (peers, you included) bound to
  the shared room closure, its closures (lemmas), and groups. That is the room's "simulation animation".
- IDENTITY: \`/name\` sets your display name; \`/password\` + \`/login\` protect a persistent identity; \`/id\`,
  \`/cap\`, \`/dyncap\` show identity/capability details. Utility: \`/help\` (full list), \`/dump\`, \`/script\`, \`/rhoqu\`.
- DOCS: MyRoom.md (join or run a room), Room_Best_Practices.md, Room_Bridges.md, and the README.

Answer only the question asked, and prefer naming the exact command. If you genuinely don't know, say so briefly.`;

// `/<cmd> optimize` — facilitate a collective-optimization round (the room as a
// quantum-annealing-style optimizer; see Collective_Optimization.md).
const optimizeKnowledge = (cmd) => `You are facilitating a COLLECTIVE-OPTIMIZATION round in a small
collaborative QuantumOS chat room — the room as a quantum-annealing-style optimizer. The loop is:
frame → generate candidates → score (cheap, trust-weighted) → select & anneal (narrow each round) →
converge. Given the problem and the recent discussion, reply with three short parts, plainly and with
no preamble:
1. OBJECTIVE — restate the goal + key constraints in one line.
2. CANDIDATES — propose 2 to 4 concrete candidate solutions, ONE LINE EACH; OR, if candidates are
   already on the table in the discussion, refine/combine the leading ones (explore wide early,
   sharpen the leaders later — that narrowing IS the annealing). Keep them compact.
3. NEXT — suggest the single next step to score them: usually \`/estimate <metric>\` for a number
   (cost, value, risk, story points) or \`/poll\` (approval or ranked) for preference; then \`/probe\`
   to confirm convergence and \`/lemma\`+\`/persist\` to record the winner. If the problem is a twist
   history that must close, \`/search\` renders the possibility space and \`/solve\` picks the
   least-free-action path directly.
Be brief and concrete. This is a metaheuristic — aim for a strong solution, not a proof of optimality.`;

// `/<cmd> chair` — chair a structured deliberation as the SINGLE neutral leader.
// Best practice (Jim's EIES finding): exactly one leader — a computer chair OR a human
// leader, never both (the two compete and stymie consensus). So the chair leads the
// room neutrally through six phases and records a decision of record at closure.
const chairKnowledge = (cmd) => `You are the SINGLE neutral CHAIR of a structured group deliberation in a
small collaborative QuantumOS chat room — the one leader for this session. Best practice is exactly one
leader: you chair, the group deliberates; do not compete with a human leader. You walk the room through
six phases — define → alternatives → evaluate → disagreements → agreements → closure — and at closure
record a decision of record. Facilitate, never dominate: neutral framing, equal airtime, surface
disagreement before converging, and never present your own opinion as the group's. Each reply is short,
plain, and specific to what was actually said — no preamble, no sign-off.`;

// `/observer summarize` — the reading of a recorded game, against its pre-registration.
const gameSummaryKnowledge = () => `You are summarizing a recorded game played in a small QuantumOS chat room. You have the
structured record: the verbatim start command (the pre-registration, made BEFORE any round), the
payoff structure if one was stated, every poll with every ballot and both the raw and the
trust-weighted tally, every estimate round, every lemma (a commitment of record), and the chat.
Write, in Markdown, these sections: **What was posed** (the game as stated; if payoffs a,b,c,d were
given, name the payoff-dominant and the risk-dominant option — S is risk-dominant iff (a−c) > (d−b)),
**Rounds** (each poll/estimate in order: who chose what, the result), **Commitments** (lemmas and
any commitment round), **Outcome**, **Against the pre-registered predictions** (one line per
prediction: held / killed / not testable from this record, with the evidence), **Notable discussion**
(quote briefly), **Data caveats** (never-closed polls, unsigned participants, missing ballots). Report
what the record shows; do not infer motives; do not take sides. Be concrete and brief.`;

const transcriptText = (transcript) =>
  (transcript || []).map((m) => (m.name ? `${m.name}: ${m.text}` : m.text)).join("\n").slice(-3000);

// Per-phase synthesis instruction for the chair mode.
const CHAIR_PHASE_INSTR = {
  define: "Summarize in one or two sentences the precise question or decision the group is taking on, and its scope.",
  alternatives: "List the distinct options or alternatives surfaced, one short line each; merge duplicates. If none yet, say so in one line.",
  evaluate: "Summarize the key considerations — pros, cons, criteria — raised for the options, in a few short lines.",
  disagreements: "Name the real cruxes of disagreement, one short line each. If there is no real disagreement, say so plainly.",
  agreements: "List the points of consensus the group has reached, one short line each.",
  closure: "Write the decision of record from the phase summaries below: the question, the chosen outcome (or that it remains unresolved), and the key rationale — 2 to 4 short sentences.",
};

function userPrompt(mode, ctx) {
  const t = transcriptText(ctx.transcript);
  if (mode === "gamesummary") {
    return `Recorded game (structured record, chronological):\n${ctx.record}\n\nWrite the summary.`;
  }
  if (mode === "chair") {
    const topic = ctx.topic ? ` on "${ctx.topic}"` : "";
    const instr = CHAIR_PHASE_INSTR[ctx.phase] || "Summarize the discussion in one or two sentences.";
    const label = ctx.phase === "closure" ? "Phase summaries so far" : "What participants said in this phase";
    return `You are chairing a structured deliberation${topic}. Current phase: ${ctx.phase}.\n${label}:\n${t || "(nothing yet)"}\n\n${instr}\nBe neutral and concrete — no preamble.`;
  }
  if (mode === "optimize") {
    const ctxLine = t ? `\n\nRecent discussion (candidates / scores so far):\n${t}` : "";
    return `Optimization problem: "${ctx.problem}"${ctxLine}\n\nFacilitate the next step of the round.`;
  }
  if (mode === "ask") {
    const ctxLine = t ? `\n\nRecent room context (for reference):\n${t}` : "";
    return `A participant asks: "${ctx.question}"${ctxLine}\n\nAnswer briefly.`;
  }
  if (mode === "stimulate") {
    const quiet = ctx.silent?.length ? `\nPresent but quiet: ${ctx.silent.join(", ")}.` : "";
    return `The conversation has gone quiet. Recent transcript:\n${t}${quiet}\n\nPost ONE short prompt that re-engages the group or invites a quieter voice to weigh in — or NONE.`;
  }
  // synthesize / disagreement → agreement
  return `Recent transcript:\n${t}\n\nIf there is a real disagreement, name the crux in one sentence and suggest the single question or next step that would move toward agreement. If people are converging or there is no real disagreement, reply NONE.`;
}

// claude-code backend: shell out to the local `claude` CLI in non-interactive print
// mode. Uses the user's Claude login (Pro/Max subscription) — NO Anthropic API credits.
// The system text is appended via --append-system-prompt; the user prompt is fed on stdin.
function callClaudeCLI({ claudeBin, model, system, prompt, log, timeoutMs = 45_000 }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "text", "--append-system-prompt", system];
    if (model) args.push("--model", model);
    let child;
    try {
      child = spawn(claudeBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { log(`[facil] claude CLI spawn failed: ${e?.message ?? e}`); return resolve(null); }
    let out = "", err = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} log("[facil] claude CLI timed out"); finish(null); }, timeoutMs);
    child.on("error", (e) => { log(`[facil] claude CLI error: ${e?.message ?? e} (is the \`claude\` CLI installed + logged in?)`); finish(null); });
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) { log(`[facil] claude CLI exit ${code}${err ? ": " + err.trim().slice(0, 200) : ""}`); return finish(null); }
      finish(out.trim());
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { log(`[facil] claude CLI stdin error: ${e?.message ?? e}`); finish(null); }
  });
}

export function makeAdvisor({ ai = false, backend = "api", apiKey = process.env.ANTHROPIC_API_KEY, model = null, claudeBin = "claude", persona = null, cmd = "facil", roleName = "facilitator", faucetActive = false, log = () => {} } = {}) {
  backend = (backend === "cli" || backend === "claude") ? "claude-code" : (backend || "api");
  // System prompt = role persona (or the facilitator default) + shared norms/knowledge.
  const sysFor = (mode) => {
    const who = persona || DEFAULT_PERSONA;
    if (mode === "ask") return `${who}\n\n${askKnowledge(cmd, faucetActive)}`;
    if (mode === "optimize") return `${who}\n\n${optimizeKnowledge(cmd)}`;
    if (mode === "chair") return `${who}\n\n${chairKnowledge(cmd)}`;
    if (mode === "gamesummary") return `${who}\n\n${gameSummaryKnowledge()}`;
    return `${who}\n\n${NUDGE_NORMS}`;
  };
  const apiModel = model || "claude-haiku-4-5-20251001";    // api backend default
  const cliModel = model || null;                            // claude-code: null = CLI's own default
  let enabled, label;
  if (!ai) { enabled = false; label = "off"; }
  else if (backend === "claude-code") { enabled = true; label = `claude-code${cliModel ? " " + cliModel : ""}`; }
  else { enabled = !!apiKey; label = enabled ? apiModel : "off"; if (!apiKey) log("[facil] --ai (api backend) set but ANTHROPIC_API_KEY missing — running deterministic only (try --ai-backend claude-code)"); }
  return {
    enabled,
    backend,
    model: label,
    /** mode: "ask" | "stimulate" | "synthesize" | "optimize" | "chair" | "gamesummary". Returns a short string, or null. */
    async advise(mode, ctx) {
      if (!enabled) return null;
      const system = sysFor(mode);
      const prompt = userPrompt(mode, ctx);
      const max_tokens = mode === "gamesummary" ? 1200 : mode === "optimize" ? 400 : mode === "chair" ? (ctx?.phase === "closure" ? 400 : 256) : mode === "ask" ? 256 : 160;
      let text = null;
      if (backend === "claude-code") {
        text = await callClaudeCLI({ claudeBin, model: cliModel, system, prompt, log, timeoutMs: mode === "gamesummary" ? 120_000 : 45_000 });
      } else {
        try {
          const res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: apiModel, max_tokens, system, messages: [{ role: "user", content: prompt }] }),
          });
          if (!res.ok) { log(`[facil] advisor HTTP ${res.status}`); return null; }
          const j = await res.json();
          text = (j?.content?.[0]?.text ?? "").trim();
        } catch (e) { log(`[facil] advisor error: ${e?.message ?? e}`); return null; }
      }
      if (!text || (mode !== "chair" && /^NONE\b/i.test(text))) return null;   // chair phases always render (e.g. "no disagreement")
      return text.slice(0, mode === "gamesummary" ? 6000 : mode === "optimize" ? 1400 : mode === "chair" ? 1200 : mode === "ask" ? 700 : 400);   // optimize/chair are multi-part; ask a few sentences; nudges terse
    },
  };
}
