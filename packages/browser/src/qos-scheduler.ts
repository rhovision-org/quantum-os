// Deterministic cooperative scheduler. No wall time, I/O, threads or ambient RNG.
// Lifecycle authority remains in QosKernel; this module only models CPU turns.
export type SchedulerLifecycle = "running" | "suspended" | "exited" | "reaped";
export type SchedulerOp = "sched_step" | "yield" | "sleep" | "sched_priority" | "sched_wake";
export const SCHEDULER_OPS: readonly SchedulerOp[] = ["sched_step", "yield", "sleep", "sched_priority", "sched_wake"];
export const MAX_PRIORITY = 3;
export const MAX_SLEEP_TICKS = 1_000_000;
export const MAX_SCHEDULER_FRONTIER = 4096;
type Task = { lifecycle: SchedulerLifecycle; priority: number; wakeAt: number | null };
type SchedulerResult = { ok: true; value: ScheduleView } | { ok: false; errno: "EINVAL" | "EAGAIN" | "ENOENT"; detail: string };
export interface ScheduleView {
  tick: number;
  running: string | null;
  ready: string[];
  remaining: number;
  tasks: { pid: string; state: "ready" | "running" | "blocked" | "zombie"; priority: number; wakeAt: number | null }[];
}
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fail = (errno: "EINVAL" | "EAGAIN" | "ENOENT", detail: string): SchedulerResult => ({ok:false,errno,detail});

export class QosScheduler {
  private tick = 0;
  private queue: string[] = [];
  private remaining = 0;
  private tasks = new Map<string, Task>();
  private receipts = new Set<string>();

  /** Every version receipt is supplied by the canonical journal, not the scheduler. */
  frontier(): string[] { return [...this.receipts].sort(cmp); }
  observe(hash: string): void { this.receipts.add(hash); }
  commitTurn(hash: string): void { this.receipts = new Set([hash]); }
  clone(): QosScheduler {
    const copy = new QosScheduler();
    copy.tick = this.tick;
    copy.queue = [...this.queue];
    copy.remaining = this.remaining;
    copy.tasks = new Map([...this.tasks].map(([pid,t]) => [pid,{...t}]));
    copy.receipts = new Set(this.receipts);
    return copy;
  }

  private eligible(t: Task): boolean {
    return t.lifecycle === "running" && (t.wakeAt === null || t.wakeAt <= this.tick);
  }
  /** Preserve the current quantum; new and newly ready tasks join at the tail.
   * Simultaneous admissions/wakes have a bytewise PID tie-break. */
  private reconcile(): void {
    const previous = this.queue[0];
    const seen = new Set<string>();
    this.queue = this.queue.filter(pid => {
      const t = this.tasks.get(pid);
      if (!t || !this.eligible(t) || seen.has(pid)) return false;
      seen.add(pid); return true;
    });
    for (const [pid,t] of [...this.tasks].sort(([a],[b]) => cmp(a,b))) {
      if (t.wakeAt !== null && t.wakeAt <= this.tick) t.wakeAt = null;
      if (this.eligible(t) && !seen.has(pid)) { this.queue.push(pid); seen.add(pid); }
    }
    const current = this.queue[0];
    if (current === undefined) this.remaining = 0;
    else if (current !== previous || this.remaining === 0) this.remaining = 1 + this.tasks.get(current)!.priority;
  }

  /** Synchronize kernel lifecycle only on accepted transitions. */
  sync(processes: readonly {pid:string;state:SchedulerLifecycle}[]): boolean {
    let changed = false;
    for (const p of processes) {
      const old = this.tasks.get(p.pid);
      if (!old) { this.tasks.set(p.pid,{lifecycle:p.state,priority:0,wakeAt:null}); changed = true; }
      else if (old.lifecycle !== p.state) {
        old.lifecycle = p.state;
        if (p.state === "exited" || p.state === "reaped") old.wakeAt = null;
        changed = true;
      }
    }
    if (changed) this.reconcile();
    return changed;
  }

  view(): ScheduleView {
    const running = this.queue[0] ?? null;
    return {
      tick:this.tick,running,ready:this.queue.slice(1),remaining:this.remaining,
      tasks:[...this.tasks].sort(([a],[b]) => cmp(a,b)).map(([pid,t]) => ({
        pid,priority:t.priority,wakeAt:t.wakeAt,
        state:t.lifecycle === "exited" || t.lifecycle === "reaped" ? "zombie" :
          pid === running ? "running" : this.eligible(t) ? "ready" : "blocked",
      })),
    };
  }
  state(): { view: ScheduleView; frontier: string[] } { return {view:this.view(),frontier:this.frontier()}; }

  /** Only the selected process spends a turn. Idle wake is explicit and jumps
   * exactly to the earliest eligible sleep deadline, never to caller-chosen time. */
  turn(pid: string, op: SchedulerOp, amount?: number): SchedulerResult {
    const task = this.tasks.get(pid);
    if (!task || task.lifecycle !== "running") return fail("ENOENT","caller is not active");
    if (op === "sched_wake") {
      if (this.queue.length || task.wakeAt === null || task.wakeAt <= this.tick)
        return fail("EAGAIN","wake requires an idle scheduler and sleeping caller");
      const deadlines = [...this.tasks.values()].filter(t => t.lifecycle === "running" && t.wakeAt !== null).map(t => t.wakeAt!);
      if (!deadlines.length) return fail("EAGAIN","no active sleepers");
      this.tick = deadlines.reduce((a,b) => Math.min(a,b));
      this.reconcile();
      return {ok:true,value:this.view()};
    }
    if (this.queue[0] !== pid) return fail("EAGAIN","caller does not own the current turn");
    if (op === "sleep" && (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_SLEEP_TICKS))
      return fail("EINVAL","invalid sleep ticks");
    if (op === "sched_priority" && (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 || amount > MAX_PRIORITY))
      return fail("EINVAL","invalid priority");
    const next = this.tick + 1;
    if (!Number.isSafeInteger(next) || (op === "sleep" && !Number.isSafeInteger(this.tick + amount!)))
      return fail("EINVAL","logical clock overflow");
    if (op === "sleep") task.wakeAt = this.tick + amount!;
    if (op === "sched_priority") task.priority = amount!;
    this.tick = next;
    this.remaining--;
    // Complete/depart the current quantum before admitting wakeups. Existing
    // waiters remain ahead of the rotated process; simultaneous wakes sort by PID.
    if (op !== "sched_step" || this.remaining === 0) {
      this.queue.shift();
      this.remaining = 0;
      if (op !== "sleep") this.queue.push(pid);
    }
    this.reconcile();
    return {ok:true,value:this.view()};
  }
}
