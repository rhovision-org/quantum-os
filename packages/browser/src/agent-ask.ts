// agent-ask.ts — choose the room's AI agent for `/ask`.
//
// Preference is deliberately simple and deterministic: a facilitator if one
// is present, otherwise the lowest peer id among the other announced agents.
// "Present" means the peer announced itself in a `name` envelope with an
// `agent` tag; the browser does not probe or vouch for it.

export interface AskAgent {
  peerId: string;
  role: string;
}

/** The command prefix an agent role answers to. The facilitator is `facil`. */
export function agentCommand(role: string): string {
  return role === "facilitator" ? "facil" : role;
}

/**
 * Pick the agent `/ask` should route to.
 *
 * - facilitator wins even when another agent has a lower peer id;
 * - otherwise the lowest peer id wins, so every browser makes the same choice;
 * - an empty/malformed announcement is ignored;
 * - null means no AI agent is present.
 */
export function pickAskAgent(agents: Iterable<[string, string]>): AskAgent | null {
  const list: AskAgent[] = [];
  for (const [peerId, rawRole] of agents) {
    const role = String(rawRole ?? "").trim().toLowerCase();
    if (!peerId || !role) continue;
    list.push({ peerId, role });
  }
  if (list.length === 0) return null;
  const facilitator = list.find((a) => a.role === "facilitator");
  if (facilitator) return facilitator;
  list.sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
  return list[0];
}

/** The chat line that reaches the chosen agent's command handler. */
export function agentAskText(agent: AskAgent, question: string): string {
  return `/${agentCommand(agent.role)} ask ${question}`;
}

export interface LiveAgentTarget {
  peerId: string;
  role: string;
  /** The command prefix the agent answers to (facilitator → facil). */
  command: string;
  /** Display name, when the caller knows it. */
  name?: string;
}

/**
 * Resolve a typed command to a live agent.
 *
 * The browser has dedicated cases for the built-in roles, but an agent may
 * announce a custom role (for example `heckler`). `/ask` already uses that
 * announcement; direct `/<role>` commands should too. A display-name alias is
 * also accepted, in which case the relay uses the agent's role prefix (a peer
 * named "heckler" with role "skeptic" is addressed as `/skeptic …`).
 *
 * Callers pass only the live roster, so a stale `peerAgents` cache cannot
 * resurrect a departed agent.
 */
export function liveAgentTarget(
  agents: Iterable<[string, string]>,
  names: ReadonlyMap<string, string>,
  command: string,
): LiveAgentTarget | null {
  const cmd = String(command ?? "").trim().toLowerCase();
  if (!cmd) return null;
  const list: LiveAgentTarget[] = [];
  for (const [peerId, rawRole] of agents) {
    if (!peerId) continue;
    const role = String(rawRole ?? "").trim().toLowerCase();
    if (!role) continue;
    const name = names.get(peerId)?.trim();
    list.push({
      peerId, role, command: agentCommand(role),
      ...(name ? { name } : {}),
    });
  }
  const byRole = list.find((a) => a.role === cmd);
  if (byRole) return byRole;
  return list.find((a) => a.name?.toLowerCase() === cmd) ?? null;
}
