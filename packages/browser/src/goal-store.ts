// goal-store.ts — private personal goals for the success framework.
//
// This is deliberately local-first. Goals are keyed by the dyncap anchor and
// never leave the browser unless the user explicitly shares one. The module is
// storage-injected so its identity scoping and persistence are testable without
// a browser.

export type GoalPriority = "urgent-important" | "important" | "urgent" | "neither";
export type GoalStatus = "open" | "done";

export interface Goal {
  id: string;
  text: string;
  priority: GoalPriority;
  status: GoalStatus;
  createdAt: number;
  completedAt?: number;
}

export interface GoalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SharedGoal {
  id: string;
  text: string;
  priority: GoalPriority;
  status: GoalStatus;
}

export const GOAL_PRIORITIES: readonly GoalPriority[] = [
  "urgent-important", "important", "urgent", "neither",
];

const STORAGE_VERSION = 1;
const isPriority = (v: unknown): v is GoalPriority =>
  typeof v === "string" && (GOAL_PRIORITIES as readonly string[]).includes(v);
const isStatus = (v: unknown): v is GoalStatus => v === "open" || v === "done";

export class GoalStore {
  private goals: Goal[] = [];
  private nextId = 1;

  constructor(
    private readonly storage: GoalStorage,
    private readonly anchor: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!anchor) throw new Error("GoalStore requires a dyncap anchor");
    this.load();
  }

  static keyFor(anchor: string): string {
    return `qos-goals:${anchor}`;
  }

  /** Snapshot; callers cannot mutate the store's array. */
  list(): Goal[] {
    return this.goals.map((g) => ({ ...g }));
  }

  add(text: string, priority: GoalPriority = "important"): Goal {
    const clean = String(text ?? "").trim();
    if (!clean) throw new Error("goal text is required");
    if (!isPriority(priority)) throw new Error(`unknown goal priority: ${priority}`);
    const goal: Goal = {
      id: `g-${this.nextId++}`,
      text: clean,
      priority,
      status: "open",
      createdAt: this.now(),
    };
    this.goals.push(goal);
    this.save();
    return { ...goal };
  }

  complete(id: string): Goal | null {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) return null;
    if (goal.status !== "done") {
      goal.status = "done";
      goal.completedAt = this.now();
      this.save();
    }
    return { ...goal };
  }

  remove(id: string): boolean {
    const before = this.goals.length;
    this.goals = this.goals.filter((g) => g.id !== id);
    if (this.goals.length === before) return false;
    this.save();
    return true;
  }

  review(): { open: Goal[]; done: Goal[] } {
    return {
      open: this.goals.filter((g) => g.status === "open").map((g) => ({ ...g })),
      done: this.goals.filter((g) => g.status === "done").map((g) => ({ ...g })),
    };
  }

  /** The only shape allowed to leave the browser; callers still choose to send it. */
  share(id: string): SharedGoal | null {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) return null;
    return { id: goal.id, text: goal.text, priority: goal.priority, status: goal.status };
  }

  private load(): void {
    let raw: string | null;
    try { raw = this.storage.getItem(GoalStore.keyFor(this.anchor)); } catch { return; }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; goals?: unknown } | null;
      if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.goals)) return;
      const loaded: Goal[] = [];
      for (const rawGoal of parsed.goals) {
        if (!rawGoal || typeof rawGoal !== "object") continue;
        const g = rawGoal as Record<string, unknown>;
        if (typeof g.id !== "string" || typeof g.text !== "string") continue;
        if (!isPriority(g.priority) || !isStatus(g.status)) continue;
        if (typeof g.createdAt !== "number" || !Number.isFinite(g.createdAt)) continue;
        const goal: Goal = {
          id: g.id, text: g.text, priority: g.priority, status: g.status, createdAt: g.createdAt,
        };
        if (typeof g.completedAt === "number" && Number.isFinite(g.completedAt)) goal.completedAt = g.completedAt;
        loaded.push(goal);
      }
      this.goals = loaded;
      const max = loaded.reduce((n, g) => {
        const m = /^g-(\d+)$/.exec(g.id);
        return m ? Math.max(n, Number(m[1])) : n;
      }, 0);
      this.nextId = max + 1;
    } catch {
      // A corrupt personal store must not break the room; start empty.
      this.goals = [];
    }
  }

  private save(): void {
    try {
      this.storage.setItem(
        GoalStore.keyFor(this.anchor),
        JSON.stringify({ v: STORAGE_VERSION, goals: this.goals }),
      );
    } catch {
      // Storage refusal is non-fatal: the in-memory list still works for this session.
    }
  }
}

/** Parse `/goal add <text> [| priority]`. */
export function parseGoalAdd(rest: string): { text: string; priority: GoalPriority } | null {
  const [textPart, priorityPart] = rest.split("|");
  const text = textPart.trim();
  if (!text) return null;
  const raw = (priorityPart ?? "").trim().toLowerCase();
  const priority: GoalPriority = !raw ? "important"
    : raw === "both" || raw === "urgent-important" ? "urgent-important"
      : raw === "important" ? "important"
        : raw === "urgent" ? "urgent"
          : raw === "neither" ? "neither"
            : "important";
  return { text, priority };
}
