// Deterministic QuantumOS / group-decision FAQ for `/<cmd> ask`.
//
// The AI advisor is optional and can be unavailable (no key, a Claude session
// limit, a CLI that is missing or logged out, a network blip). Those failures
// must not turn a basic question about the room or its decision procedures into
// "Hmm, I don't have a good answer." This module answers the common questions
// without a model, so the facilitator stays useful when the backend does not.
//
// Plain JS, no imports, node-runnable:
//   node scripts/qos-cli/facilitator-faq.mjs --selftest
//
// The answers are deliberately compact and command-first: if a slash command
// answers the question, name the exact command.

const C = (cmd) => `/${cmd}`;

const RULES = [
  {
    id: "what-can-you-do",
    test: [/\bwhat (can|do) you do\b/, /\bwho are you\b/, /\bwhat are you\b/, /^help$/, /\bhow (do|can) i ask\b/],
    answer: ({ cmd }) =>
      `I'm a room agent: I can answer basics about QuantumOS and group decisions without the AI backend, and open-ended questions when it is available. Try \`${C(cmd)} ask what is /poll\` or \`${C(cmd)} help\` for the command list.`,
  },
  {
    id: "quantum-os",
    test: [/\bquantum[ -]?os\b/, /\bwhat is qos\b/, /\bwhat is this (system|platform)\b/],
    answer: ({ cmd }) =>
      `QuantumOS is a peer-to-peer room, not a server: a room id is a ZFA capability token, and possessing it is the authorization to join. There are no accounts and no stored history — messages reach only peers connected at that moment, and state is gone when the last one leaves unless an agent carries it with \`--persist\`. Everything is off-chain by default; \`/rholang\` is the opt-in chain path. Use \`${C(cmd)} ask <question>\` for more.`,
  },
  {
    id: "room",
    test: [/\bwhat is (this|a) room\b/, /\bhow does (the )?room work\b/, /\bhow do (i|we) join\b/],
    answer: () =>
      "A room is a shared ZFA process space: the URL's `#room=cap:room:…` token IS the invitation — anyone with the link can join, no account needed. `/room` lists, joins, and leaves rooms; each tab is its own room. Messages reach only peers connected at that moment, so use a memory agent (`--persist`) if the room must outlive the last browser.",
  },
  {
    id: "decision",
    test: [/\b(make|reach|take) a decision\b/, /\bdecision (process(es)?|making)\b/, /\bdecide (something|together)\b/, /\bgroup decision\b/, /\bhow (do|should|can) (we|i) (decide|choose)\b/],
    answer: ({ cmd }) =>
      "A practical sequence is: `/poll` to collect options and ballots, `/probe` to check whether peers agree, `/estimate` for a numeric question, then `/lemma` to name the decision and `/persist` to record it. For weighted or liquid-democracy decisions use `/gov delegate` and `/gov trust`; `/gov censure` is the accountability path. The group decides — I only help frame and summarize.",
  },
  {
    id: "poll",
    test: [/\bpoll\b/, /\bvote\b/, /\branked\b/, /\bapproval\b/],
    answer: () =>
      "`/poll <question>` opens an approval or ranked vote; options are collected in the room and the tally is computed locally by every peer. Use ranked when you need a single winner, approval when you want the acceptable set. The creator can lock nominations and close the poll; `/probe` is the separate agreement check.",
  },
  {
    id: "probe",
    test: [/\bprobe\b/, /\bconsensus\b/, /\bdisagree(ment)?\b/],
    answer: () =>
      "`/probe` samples peers' state and resolves a discrepancy only when a 2/3 supermajority supports one value; otherwise it surfaces the disagreement instead of hiding it. It is a joiner-local reconciliation check, not full Byzantine consensus.",
  },
  {
    id: "estimate",
    test: [/\bestimate\b/, /\bmedian\b/, /\bspread\b/],
    answer: () =>
      "`/estimate <metric>` collects numbers from the room and reports the median and spread — use it for a quantity (cost, risk, story points), not a preference. Follow with `/probe` if you need to check whether the room actually converged.",
  },
  {
    id: "lemma",
    test: [/\blemma\b/, /\bclaim\b/, /\brecord (a )?(decision|claim)\b/, /\bcommit(ment)?\b/],
    answer: () =>
      "`/lemma <claim>` names a claim; mark the handle with `@`, e.g. `/lemma All men are @mortal`. Twists auto-allocate or can be supplied after a pipe. `/persist` records it durably in the room, and other commands can reuse it as `@handle`.",
  },
  {
    id: "governance",
    test: [/\bgov\b/, /\bgovernance\b/, /\bdelegat/, /\bliquid democracy\b/, /\btrust\b/, /\bcensure\b/],
    answer: () =>
      "`/gov` is the liquid-democracy layer: `/gov delegate`, `/gov trust`, `/gov censure`, and `/gov say`; voting weight follows delegation and trust. Groups and their decisions live in the room by default. Recording governance on chain is optional via `/gov chain`, which needs a deploy key but no mandatory chain.",
  },
  {
    id: "zfa",
    test: [/\bzfa\b/, /\bzero free action\b/, /\bcapability token\b/, /\bwhat is a capability\b/],
    answer: () =>
      "ZFA means Zero Free Action: a process whose twist history is count-balanced and Pauli-closed, so it returns to itself up to a phase. Every room, peer, and capability token is built as a ZFA-balanced object; possessing the token IS the authorization, with no ACL or account behind it. You normally don't need the algebra to use the room — `/zfa` and `/qucalc` expose it when you want to inspect a claim.",
  },
  {
    id: "invite",
    test: [/\binvite\b/, /\bshare (the )?room\b/, /\broom (link|url)\b/, /\bhow do (i|we) share\b/],
    answer: () =>
      "Share the room URL (the `#room=cap:room:…` link). Anyone with it can join; no account or approval step. `/room` manages the rooms/tabs you are in, and `/share <selector> to <room>` copies a lemma, note, or chat line into another room you have open.",
  },
  {
    id: "agents",
    test: [/\bagents?\b/, /\bfacilitator\b/, /\bscribe\b/, /\bskeptic\b/, /\bgreeter\b/, /\bobserver\b/],
    answer: ({ cmd }) =>
      `Room agents are full peers: the facilitator greets, summarizes, and chairs; the scribe keeps screen history; the skeptic verifies claims; the greeter welcomes; the observer records games. They are trust-governable — \`/gov trust\` or \`/gov censure\` them. This agent speaks only for itself; use \`${C(cmd)} help\` for its own commands.`,
  },
  {
    id: "channel",
    test: [/\bchannel\b/, /\bmessage\b/, /\bchat\b/, /\binbox\b/],
    answer: () =>
      "`/channel listen|send <name> <text>` is a tagged channel; `/share <selector> to <room>` moves a lemma/note/chat line to another room. A channel that must outlive the room can go on chain with `/channel chain open|post|subscribe|read`.",
  },
  {
    id: "chain",
    test: [/\brholang\b/, /\bchain\b/, /\bdeploy\b/, /\brnode\b/, /\bblockchain\b/],
    answer: () =>
      "Chain use is opt-in: `/rholang status|eval|deploy` and `/rholang key generate` for a deploy key; `/rholang powerbox` lists the connectors. Nothing else in the room needs a chain, a key, or phlo — a room is whole without one.",
  },
  {
    id: "identity",
    test: [/\bidentity\b/, /\bpeer id\b/, /\bpassword\b/, /\blogin\b/, /\bname\b/, /\bdyncap\b/],
    answer: () =>
      "`/name` sets your display name; `/password` + `/login` protect a persistent identity; `/id`, `/cap`, and `/dyncap` inspect the identity/capability chain. `/gov claim` reattaches an orphaned group (at most one member) after a peer-id change.",
  },
  {
    id: "files",
    test: [/\bfiles?\b/, /\bmedia\b/, /\bcall\b/, /\brecord\b/, /\brender\b/],
    answer: () =>
      "The call bar handles live media; `/record` records the screen; `/file` handles attachments and the library; `/render` opens an animation of this room's perspectives and closures. `/record` and `/file` are room tools, not chain operations.",
  },
  {
    id: "optimize",
    test: [/\boptimi[sz]e\b/, /\banneal/, /\bcandidate/],
    answer: ({ cmd }) =>
      `\`${C(cmd)} optimize <objective + constraints>\` runs a collective-optimization round: it proposes candidates and suggests a cheap scoring step like \`/estimate\` or \`/poll\`, then \`/probe\` and \`/lemma\` to converge and record. It is a metaheuristic — a good solution, not a proof of optimality.`,
  },
  {
    id: "chair",
    test: [/\bchair\b/, /\bdeliberat/],
    answer: ({ cmd }) =>
      `\`${C(cmd)} chair <topic>\` runs a six-phase deliberation — define, alternatives, evaluate, disagreements, agreements, closure — and records a decision at the end. Steer it with \`${C(cmd)} next\`, \`back\`, \`close\`, or \`cancel\`.`,
  },
];

/**
 * Answer a question from the built-in QuantumOS / decision knowledge base.
 * Returns a compact string, or null when the question is not a known topic
 * (the caller may then use the AI advisor).
 */
export function answerFromKnowledge(question, { cmd = "facil" } = {}) {
  const q = String(question ?? "").trim().toLowerCase();
  if (!q) return null;
  for (const rule of RULES) {
    if (rule.test.some((re) => re.test(q))) return rule.answer({ cmd });
  }
  return null;
}

export function knowledgeTopics() {
  return RULES.map((rule) => rule.id);
}

export function selftest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
  };
  const has = (q, re, cmd) => {
    const a = answerFromKnowledge(q, { cmd });
    ok(`${q} → ${re}`, !!a && re.test(a), a ? a.slice(0, 80) : "null");
  };

  has("what is quantum-os?", /peer-to-peer/i);
  has("what is this room?", /capability|invitation/i);
  has("how do we make a decision?", /\/poll/);
  has("how should we decide?", /\/poll/);
  has("what are the decision processes?", /\/poll/);
  has("what is /poll?", /ranked|approval/i);
  has("what is a probe?", /2\/3|supermajority/i);
  has("how do we estimate something?", /median/i);
  has("what is a lemma?", /@handle|@/);
  has("how does governance work?", /liquid-democracy|\/gov/i);
  has("what is ZFA?", /Zero Free Action|capability/i);
  has("how do I invite someone?", /room URL|link/i);
  has("what can you do?", /\/scribe ask/i, "scribe");
  has("how do I record a decision?", /\/lemma/);
  has("what is /rholang?", /opt-in|deploy/i);
  has("what are the agents?", /facilitator|scribe|skeptic/i);

  ok("an unrelated question is left to the AI backend", answerFromKnowledge("what is the weather in Lisbon?") === null);
  ok("an empty question is not answered", answerFromKnowledge("") === null);
  ok("knowledge topics are non-empty", knowledgeTopics().length >= 10);
  ok("a non-facilitator command prefixes its own name",
    answerFromKnowledge("what can you do?", { cmd: "scribe" })?.includes("/scribe ask"));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

if (typeof process !== "undefined" && process.argv?.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}
