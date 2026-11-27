// goal-store.ts — private personal goals for the success framework.
//
// This is deliberately local-first. Goals are keyed by the dyncap anchor and
// never leave the browser unless the user explicitly shares one. The module is
// storage-injected so its identity scoping and persistence are testable without
// a browser.

export type GoalPriority = "urgent-important" | "important" | "urgent" | "neither";
export type GoalStatus = "open" | "done";
export type HabitCadence = "daily" | "weekly";

export interface Habit {
  id: string;
  text: string;
  cadence: HabitCadence;
  /** UTC calendar dates; at most one check-in for a habit on each date. */
  checkIns: string[];
  createdAt: number;
}

export interface GoalReview {
  id: string;
  at: number;
  text: string;
  open: number;
  done: number;
  habitsChecked: number;
}

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

const STORAGE_VERSION = 2;
const isDate = (x: unknown): x is string => typeof x === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(x)
  && !Number.isNaN(Date.parse(x + "T00:00:00.000Z"))
  && new Date(x + "T00:00:00.000Z").toISOString().slice(0, 10) === x;
const isCadence = (x: unknown): x is HabitCadence => x === "daily" || x === "weekly";
const isPriority = (v: unknown): v is GoalPriority =>
  typeof v === "string" && (GOAL_PRIORITIES as readonly string[]).includes(v);
const isStatus = (v: unknown): v is GoalStatus => v === "open" || v === "done";

export class GoalStore {
  private goals: Goal[] = [];
  private nextId = 1;
  private habits: Habit[] = [];
  private nextHabitId = 1;
  private reviews: GoalReview[] = [];
  private nextReviewId = 1;

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

  /** Personal habits never leave this store unless explicitly read by the owner. */
  listHabits(): Habit[] {
    return this.habits.map(h => ({ ...h, checkIns: [...h.checkIns] }));
  }

  addHabit(text: string, cadence: HabitCadence = "daily"): Habit {
    const name = String(text ?? "").trim();
    if (!name || name.length > 240 || !isCadence(cadence)) throw new Error("invalid habit or cadence");
    const habit: Habit = { id: "h-" + this.nextHabitId++, text: name, cadence,
      checkIns: [], createdAt: this.now() };
    this.habits.push(habit);
    this.save();
    return { ...habit, checkIns: [] };
  }

  /** A second check-in on the same UTC date is idempotent. */
  checkInHabit(id: string, date = new Date(this.now()).toISOString().slice(0, 10)): Habit | null {
    if (!isDate(date)) throw new Error("invalid ISO UTC calendar date");
    const habit = this.habits.find(h => h.id === id);
    if (!habit) return null;
    if (!habit.checkIns.includes(date)) {
      habit.checkIns.push(date);
      habit.checkIns.sort();
      // Bound storage consumption; never silently share check-ins.
      habit.checkIns = habit.checkIns.slice(-366);
      this.save();
    }
    return { ...habit, checkIns: [...habit.checkIns] };
  }

  removeHabit(id: string): boolean {
    const count = this.habits.length;
    this.habits = this.habits.filter(h => h.id !== id);
    if (this.habits.length === count) return false;
    this.save();
    return true;
  }

  /** Snapshot at review time: no personal data or identities in any network event. */
  recordReview(text = ""): GoalReview {
    const note = String(text ?? "").trim();
    if (note.length > 2000) throw new Error("review note exceeds 2000 characters");
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const item: GoalReview = {
      id: "r-" + this.nextReviewId++, at: this.now(), text: note,
      open: this.goals.filter(g => g.status === "open").length,
      done: this.goals.filter(g => g.status === "done").length,
      habitsChecked: this.habits.filter(h => h.checkIns.includes(today)).length,
    };
    this.reviews.push(item);
    this.reviews = this.reviews.slice(-100);
    this.save();
    return { ...item };
  }

  listReviews(): GoalReview[] {
    return this.reviews.map(r => ({ ...r }));
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
      const parsed = JSON.parse(raw) as {
        v?: unknown; goals?: unknown; habits?: unknown; reviews?: unknown;
      } | null;
      // v1 records containing only goals migrate in memory without data loss.
      if (!parsed || (parsed.v !== 1 && parsed.v !== STORAGE_VERSION)
        || !Array.isArray(parsed.goals)) return;
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
      if (parsed.v === STORAGE_VERSION) {
        if (Array.isArray(parsed.habits)) {
          this.habits = parsed.habits.flatMap((value): Habit[] => {
            if (!value || typeof value !== "object") return [];
            const h = value as Record<string, unknown>;
            if (typeof h.id !== "string" || !/^h-\d+$/.test(h.id)
              || typeof h.text !== "string" || h.text.length > 240
              || !isCadence(h.cadence) || !Array.isArray(h.checkIns)
              || typeof h.createdAt !== "number" || !Number.isFinite(h.createdAt)) return [];
            return [{
              id: h.id, text: h.text, cadence: h.cadence,
              checkIns: [...new Set(h.checkIns.filter(isDate))].sort().slice(-366),
              createdAt: h.createdAt,
            }];
          });
          this.nextHabitId = 1 + this.habits.reduce((n, h) =>
            Math.max(n, Number(h.id.slice(2))), 0);
        }
        if (Array.isArray(parsed.reviews)) {
          this.reviews = parsed.reviews.flatMap((value): GoalReview[] => {
            if (!value || typeof value !== "object") return [];
            const r = value as Record<string, unknown>;
            if (typeof r.id !== "string" || !/^r-\d+$/.test(r.id)
              || typeof r.text !== "string" || r.text.length > 2000
              || ![r.at, r.open, r.done, r.habitsChecked].every(v =>
                typeof v === "number" && Number.isFinite(v) && v >= 0)) return [];
            return [{
              id: r.id, text: r.text, at: r.at as number, open: r.open as number,
              done: r.done as number, habitsChecked: r.habitsChecked as number,
            }];
          }).slice(-100);
          this.nextReviewId = 1 + this.reviews.reduce((n, r) =>
            Math.max(n, Number(r.id.slice(2))), 0);
        }
      }
    } catch {
      // A corrupt personal store must not break the room; start empty.
      this.goals = [];
    }
  }

  private save(): void {
    try {
      this.storage.setItem(
        GoalStore.keyFor(this.anchor),
        JSON.stringify({ v: STORAGE_VERSION, goals: this.goals,
          habits: this.habits, reviews: this.reviews }),
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
