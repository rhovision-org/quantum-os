// #289: explicit, identity/room-bound, single-use preflight for RhoQu authored
// by an agent or imported from a room. No command is dispatched by this module.
export interface RhoQuPreview<H> {
  token: string;
  roomId: string;
  identity: string;
  stateFingerprint: string;
  createdAt: number;
  source: string;
  commands: string[];
  handlers: H[];
  highImpact: boolean;
}

const MAX_SOURCE = 16_384;
const MAX_COMMANDS = 200;
const TTL_MS = 10 * 60_000;

// Effect classes are informational. Every preview, including a read-only one,
// requires an explicit confirm. Unknown commands are treated as high impact.
export function isHighImpactCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed.startsWith("/")) return true;
  const [verb, sub] = trimmed.slice(1).trim().toLowerCase().split(/\s+/);
  if (verb === "help" || verb === "id" || verb === "zfa-check" ||
      verb === "coupling" || verb === "freq" || verb === "braket" ||
      verb === "qucalc" || verb === "search" || verb === "solve") return false;
  if (verb === "goal") return !["list","review"].includes(sub || "");
  if (verb === "poll") return !["list","status"].includes(sub || "");
  if (verb === "gov") return !["list","status"].includes(sub || "");
  if (verb === "qos") return !["ps","status","list"].includes(sub || "");
  return true;
}

export class RhoQuPreviewStore<H> {
  private drafts = new Map<string, RhoQuPreview<H>>();
  constructor(private readonly now: () => number = () => Date.now(),
    private readonly random: (n: number) => Uint8Array =
      n => crypto.getRandomValues(new Uint8Array(n))) {}

  prepare(
    source: string, commands: readonly string[], handlers: readonly H[],
    roomId: string, identity: string, stateFingerprint: string,
  ): RhoQuPreview<H> {
    if (!roomId || !identity || !stateFingerprint) throw new Error("missing room/identity/snapshot");
    if (!source.trim() || source.length > MAX_SOURCE) throw new Error("RhoQu source exceeds 16 KiB or is empty");
    if (/cap:room:/i.test(source) || commands.some(c => /cap:room:/i.test(c))) {
      throw new Error("preview refuses a raw room bearer capability");
    }
    if (commands.length + handlers.length === 0 ||
        commands.length > MAX_COMMANDS || handlers.length > 50) {
      throw new Error("preview has no actions or exceeds budget");
    }
    for (const c of commands) {
      if (typeof c !== "string" || !c.trim().startsWith("/") || c.length > 8192)
        throw new Error("invalid command in preview");
    }
    // A fresh approval intent supersedes older intents in the same room.
    for (const [token, p] of this.drafts) {
      if (p.roomId === roomId || this.now() - p.createdAt > TTL_MS) this.drafts.delete(token);
    }
    const token = [...this.random(12)].map(b => b.toString(16).padStart(2,"0")).join("");
    if (!/^[0-9a-f]{24}$/.test(token) || this.drafts.has(token)) {
      throw new Error("approval token collision/invalid entropy");
    }
    const plan: RhoQuPreview<H> = {
      token, roomId, identity, stateFingerprint, createdAt: this.now(),
      source, commands: [...commands], handlers: [...handlers],
      highImpact: commands.some(isHighImpactCommand) || handlers.length > 0,
    };
    this.drafts.set(token, plan);
    return {
      ...plan, commands: [...plan.commands], handlers: [...plan.handlers],
    };
  }

  // Single-use regardless of success or failure. This guards replay and stale
  // state, but is not itself permission to bypass ordinary /command checks.
  take(token: string, roomId: string, identity: string, stateFingerprint: string): RhoQuPreview<H> {
    const plan = this.drafts.get(token);
    if (!plan) throw new Error("no pending RhoQu preview for that token");
    this.drafts.delete(token);
    if (this.now() - plan.createdAt > TTL_MS || this.now() < plan.createdAt)
      throw new Error("RhoQu preview has expired");
    if (plan.roomId !== roomId || plan.identity !== identity)
      throw new Error("preview was created for another room or identity");
    if (plan.stateFingerprint !== stateFingerprint)
      throw new Error("room state changed since preview; create a fresh preview");
    return { ...plan, commands: [...plan.commands], handlers: [...plan.handlers] };
  }

  cancel(token: string): boolean { return this.drafts.delete(token); }
  pending(roomId: string): number {
    return [...this.drafts.values()].filter(p => p.roomId === roomId).length;
  }
}
