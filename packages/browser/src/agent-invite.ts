// agent-invite.ts — what `/agent add` hands someone to put an AI agent in a room.
//
// An agent is a headless peer (scripts/qos-cli/agent.mjs) that has to run on
// some computer; the browser cannot start one. What it can do is remove every
// step but one: build the exact command, with this room already in it, and the
// equivalent request for a Claude session that has no terminal on your side.
// Pure — no DOM, storage or network — so test/agent-invite.test.mjs covers it.

export const DEFAULT_SIGNAL = "wss://quantum-os-signaling.onrender.com";
export const REPO_URL = "https://github.com/rhovision-org/quantum-os";
export const AGENT_DOCS_URL = `${REPO_URL}/blob/main/docs/agents-from-claude.md`;

/** The roles scripts/qos-cli/add-agent.sh accepts, with what each is for. */
export const AGENT_ROLES: ReadonlyArray<{ role: string; what: string }> = [
  { role: "facilitator", what: "greets people, keeps the conversation balanced, answers /ask, chairs a deliberation" },
  { role: "skeptic", what: "checks the room's claims and flags a history that only passes the weaker ZFA test" },
  { role: "scribe", what: "keeps notes and summarizes" },
  { role: "greeter", what: "welcomes newcomers and asks their names, nothing more" },
  { role: "observer", what: "records live games (/observer start … stop)" },
];

/**
 * The AI providers `/agent add --ai <p>` can name — each a plugin in
 * scripts/qos-cli/ai-providers/. Keys are never part of the request: the
 * machine running the agent reads its own environment.
 */
export const AGENT_PROVIDERS: ReadonlyArray<{ id: string; script: string; key: string | null; what: string }> = [
  { id: "claude", script: "claude-code", key: null, what: "Claude through the claude CLI — your Claude plan, no API key" },
  { id: "anthropic", script: "anthropic", key: "ANTHROPIC_API_KEY", what: "Claude through the Anthropic API" },
  { id: "deepseek", script: "deepseek", key: "DEEPSEEK_API_KEY", what: "DeepSeek through its API" },
  { id: "none", script: "off", key: null, what: "no AI — greets and answers basics from its built-in FAQ" },
];

export interface AgentRequest {
  role: string;
  name?: string;
  /** An AGENT_PROVIDERS id; absent = let add-agent.sh pick what it can use. */
  ai?: string;
  model?: string;
}

/**
 * Parse the argument of `/agent add [role] [display name…]`.
 * The role defaults to facilitator. A first word that is not a role is taken
 * as the start of the name, so `/agent add Socrates` is a facilitator named
 * Socrates. Names are kept to letters, digits, spaces, `.`, `_` and `-` so they
 * can be quoted into a shell command safely.
 */
export function parseAgentRequest(arg: string): AgentRequest | { error: string } {
  const words = arg.trim().split(/\s+/).filter(Boolean);
  let ai: string | undefined;
  let model: string | undefined;
  // Flags may sit anywhere: --ai <provider>, --model <model>.
  for (let i = 0; i < words.length; ) {
    const w = words[i].toLowerCase();
    if (w === "--ai" || w === "--model") {
      const v = words[i + 1];
      if (!v) return { error: `${w} needs a value` };
      if (w === "--ai") {
        const id = v.toLowerCase();
        if (!AGENT_PROVIDERS.some((p) => p.id === id)) {
          return { error: `unknown AI provider "${v}" — choose ${AGENT_PROVIDERS.map((p) => p.id).join(", ")}` };
        }
        ai = id;
      } else {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,63}$/.test(v)) return { error: `"${v}" doesn't look like a model name` };
        model = v;
      }
      words.splice(i, 2);
    } else i++;
  }
  if (model && ai === "none") return { error: "--model needs an AI provider, not none" };
  let role = "facilitator";
  if (words.length && AGENT_ROLES.some((r) => r.role === words[0].toLowerCase())) {
    role = words.shift()!.toLowerCase();
  }
  const name = words.join(" ");
  const req: AgentRequest = { role };
  if (ai) req.ai = ai;
  if (model) req.model = model;
  if (!name) return req;
  if (name.length > 32 || !/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(name)) {
    return { error: "an agent's name is up to 32 letters, digits, spaces, '.', '_' or '-', starting with a letter" };
  }
  return { ...req, name };
}

/** The provider entry a request names, if it names one. */
export function providerOf(req: AgentRequest) {
  return req.ai ? AGENT_PROVIDERS.find((p) => p.id === req.ai) ?? null : null;
}

/** The environment prefix add-agent.sh reads for the provider and model. */
function aiEnv(req: AgentRequest): string {
  const p = providerOf(req);
  return (p ? `AI=${p.script} ` : "") + (req.model ? `AI_MODEL=${quote(req.model)} ` : "");
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One line to paste into a terminal on any computer with git and Node 18+.
 * It keeps its own checkout under ~/.qos-agents, so it never touches a
 * development clone, and updates it on every run.
 */
export function agentShellCommand(roomCap: string, req: AgentRequest, signalUrl = DEFAULT_SIGNAL): string {
  const d = `"$HOME/.qos-agents/quantum-os"`;
  const sig = signalUrl && signalUrl !== DEFAULT_SIGNAL ? `SIGNAL=${quote(signalUrl)} ` : "";
  const name = req.name ? ` ${quote(req.name)}` : "";
  return `if [ -d ${d}/.git ]; then git -C ${d} pull -q --ff-only; `
    + `else git clone -q --depth 1 ${REPO_URL}.git ${d}; fi && `
    + `${sig}${aiEnv(req)}bash ${d}/scripts/qos-cli/add-agent.sh ${quote(roomCap)} ${req.role}${name}`;
}

/** The same request, worded for a Claude Code session to carry out. */
export function agentClaudePrompt(roomLink: string, req: AgentRequest, signalUrl = DEFAULT_SIGNAL): string {
  const named = req.name ? ` named "${req.name}"` : "";
  const sig = signalUrl && signalUrl !== DEFAULT_SIGNAL ? `SIGNAL=${quote(signalUrl)} ` : "";
  const p = providerOf(req);
  const using = p && p.id !== "none" ? `, using ${p.what}${req.model ? ` (model ${req.model})` : ""}` : "";
  const keyNote = p?.key ? `It reads ${p.key} from your environment; if that is not set, ask me to set it there — never in the room. ` : "";
  return `Add a ${req.role} AI agent${named} to my QuantumOS room ${roomLink}${using}. `
    + keyNote
    + `Clone ${REPO_URL} and run: ${sig}${aiEnv(req)}bash scripts/qos-cli/add-agent.sh ${quote(roomLink)} ${req.role}`
    + `${req.name ? " " + quote(req.name) : ""} `
    + `— if the signaling server (${signalUrl || DEFAULT_SIGNAL}) is blocked from your environment, tell me instead of retrying. `
    + `Guide: ${AGENT_DOCS_URL}`;
}

/**
 * Hide a room capability inside text shown on screen, for a room the person
 * has hidden (`/room hide`): the cap is a bearer capability, and the
 * transcript is in every screen share. The clipboard keeps the full text.
 */
export function maskCap(text: string, roomCap: string): string {
  if (!roomCap) return text;
  const hex = roomCap.split(":")[2] ?? roomCap;
  const short = `cap:room:${hex.slice(0, 8)}…`;
  return text.split(roomCap).join(short).split(encodeURIComponent(roomCap)).join(short);
}
