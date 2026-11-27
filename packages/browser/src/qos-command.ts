// qos-command.ts — the room-facing `/qos` surface over `qos-process.ts`.
//
// `QosProcessRoom` already matches the browser's `QOSPeer.broadcast` /
// `onMessage` shape; this module supplies the part a person actually types:
// start / status / suspend / resume / terminate, process-name resolution, and
// the chat lines a room sees when a process changes state.
//
// It stays deliberately thin. It does not sign anything itself, does not
// change `/poll` or `/gov`, and does not call a chain. Every lifecycle
// transition is the dyncap-attributed event `QosProcessRoom` already knows how to make.

import { SCHEDULER_OPS, type SchedulerOp } from "./qos-scheduler.js";
import type { DynCapState } from "./dyncap.js";
import { replayQosKernel, previewCanonicalSyscall, canonicalSyscallReady } from "./qos-kernel.js";
import {
  QosProcessRoom,
  parseQosEvent,
  type QosEvent,
  type QosProcessView,
  type QosTransport,
} from "./qos-process.js";

export interface QosCommandHost {
  roomId: string;
  identity: DynCapState;
  transport: QosTransport;
  /** Say a line in the room (the app supplies its system-message sink). */
  say: (text: string) => void;
  /** Another peer's display label, for the "who did it" part of a line. */
  label?: (source: string) => string;
  /** Persist the dyncap sequence after a locally dyncap-attributed event. */
  onSigned?: () => void;
}

interface TrackedProcess {
  id: string;
  name: string;
  start: QosEvent;
  /** Peer id for an inbound start, or "you" for a locally started process. */
  owner: string;
  /** Dyncap anchor on the start event (the process's authority root). */
  ownerAnchor: string;
}

const short = (hash: string): string => `${hash.slice(0, 12)}…`;

const USAGE = [
  "QOS processes — named, capability-guarded continuations in this room:",
  "  /qos start <name> [| <question>]  — start a process you own",
  "  /qos syscall <name|id> | <op> | <JSON args> — bounded owner syscall",
  "  /qos ps                          — process table: pid · name · state · owner",
  "  /qos status [name|id]             — list, or show one process and its digest",
  "  /qos suspend <name|id> [| reason] — owner pauses it",
  "  /qos resume <name|id> [| reason]  — owner resumes it",
  "  /qos terminate <name|id> [| reason] — owner ends it",
  "  /qos kill <name|id> [| reason]    — alias for terminate (owner only)",
  "The events are dyncap-attributed and broadcast; every peer recomputes the same digest.",
];

export class QosCommand {
  readonly room: QosProcessRoom;
  private readonly byId = new Map<string, TrackedProcess>();
  private readonly byName = new Map<string, string>();
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(private readonly host: QosCommandHost) {
    this.room = new QosProcessRoom({
      roomId: host.roomId,
      identity: host.identity,
      transport: host.transport,
    });
  }

  /** Processes this peer has seen start, oldest first. */
  list(): { id: string; name: string; start: QosEvent; owner: string; ownerAnchor: string }[] {
    return [...this.byId.values()].map((p) => ({
      id: p.id, name: p.name, start: p.start, owner: p.owner, ownerAnchor: p.ownerAnchor,
    }));
  }

  /** The current view of a tracked process, or null when it is unknown. */
  async view(ref: string): Promise<QosProcessView | null> {
    const entry = this.resolve(ref);
    return entry ? this.room.view(entry.id) : null;
  }

  /** Feed one inbound QOS envelope. Returns true when it was accepted or known. */
  async ingest(from: string, data: unknown): Promise<boolean> {
    const event = parseQosEvent(data);
    if (!event) return false;
    const result = await this.room.log.ingest(event);
    if (!result.ok) return false;
    if (result.duplicate) return true;

    const entry = this.track(event, from);
    if (event.type === "process-start" && entry) {
      this.host.say(`🧩 ${this.label(from)} started **${entry.name}** — \`/qos status ${entry.name}\``);
    } else if (event.type === "process-suspend" || event.type === "process-resume" || event.type === "process-terminate") {
      const name = this.byId.get(event.process)?.name ?? event.process;
      const verb = event.type === "process-suspend" ? "suspended"
        : event.type === "process-resume" ? "resumed" : "terminated";
      const icon = event.type === "process-suspend" ? "⏸" : event.type === "process-resume" ? "▶" : "⏹";
      this.host.say(`${icon} **${name}** ${verb} by ${this.label(from)}`);
    }
    return true;
  }

  /** Handle the argument after `/qos` (no leading command). */
  async handle(raw: string): Promise<void> {
    const run = this.commandQueue.then(() => this.dispatch(raw));
    this.commandQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async dispatch(raw: string): Promise<void> {
    const text = raw.trim();
    const sub = (text.split(/\s+/, 1)[0] || "status").toLowerCase();
    const rest = text.slice(sub.length).trim();

    switch (sub) {
      case "help":
        for (const line of USAGE) this.host.say(line);
        return;
      case "start":
        return this.start(rest);
      case "status":
      case "list":
        return this.status(rest);
      case "ps":
        return this.ps();
      case "syscall":
        return this.syscall(rest);
      case "suspend":
      case "resume":
      case "terminate":
      case "kill":
        return this.lifecycle(sub === "kill" ? "terminate" : sub, rest);
      default:
        this.host.say(`unknown /qos subcommand: ${sub}`);
        for (const line of USAGE) this.host.say(line);
    }
  }

  private async start(rest: string): Promise<void> {
    const [namePart, ...questionParts] = rest.split("|");
    const name = namePart.trim();
    if (!name) {
      this.host.say("usage: /qos start <name> [| <question>]");
      return;
    }
    if (this.byName.has(name)) {
      this.host.say(`a process named **${name}** already exists — \`/qos status ${name}\``);
      return;
    }
    const question = questionParts.join("|").trim() || name;
    const started = await this.room.startProcess(name, { question });
    this.host.onSigned?.();
    this.track(started.event, "you");
    const view = await this.room.view(started.processId);
    this.host.say(`🧩 started **${name}** — ${view.status} · ${started.processId} · digest ${short(view.stateDigest)}`);
  }

  private async status(rest: string): Promise<void> {
    if (this.byId.size === 0) {
      this.host.say("no QOS processes in this room — start one with `/qos start <name>`");
      return;
    }
    if (rest) {
      const entry = this.resolve(rest);
      if (!entry) {
        this.host.say(`no process named or identified by **${rest}** — \`/qos status\``);
        return;
      }
      const view = await this.room.view(entry.id);
      const kernel = replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
      const process = kernel.kernel.getProcess(entry.id);
      this.host.say(`**${entry.name}** — kernel: ${process?.state ?? "unavailable"} · orchestration: ${view.status}/${view.phase}`);
      this.host.say(`  process: ${entry.id}`);
      this.host.say(`  owner: ${this.ownerLabel(entry)}`);
      this.host.say(`  events: ${view.eventCount} · quorum ${view.quorum.required}${view.quorum.met ? " met" : ` missing ${view.quorum.missing.length}`}`);
      if (view.nominations.length) {
        this.host.say(`  nominations: ${view.nominations.map((n) => `${n.text} (${n.by.length})`).join(" · ")}`);
      }
      if (view.poll) {
        this.host.say(`  poll: ${view.poll.ballotCount} ballot(s), ${view.poll.optionIds.length} option(s)${view.result ? ` — ${view.winnerTexts.join(" / ")}` : ""}`);
      }
      if (view.rejected.length || view.conflictedSources.length) {
        this.host.say(`  rejected ${view.rejected.length} · conflicted ${view.conflictedSources.length} · broken chains ${view.brokenChains.length}`);
      }
      this.host.say(`  state digest: ${view.stateDigest}`);
      this.host.say(`  kernel digest: ${await kernel.kernel.stateDigest()}`);
      this.host.say(`  scheduler: ${JSON.stringify(kernel.kernel.scheduleView())}`);
      this.host.say(`  canonical syscalls: ${kernel.syscalls.filter(item => item.caller === entry.id).length}`);
      if (view.finalDigest) this.host.say(`  final digest: ${view.finalDigest}`);
      return;
    }

    this.host.say(`QOS processes (${this.byId.size}):`);
    const replay = replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
    for (const entry of this.list()) {
      const view = await this.room.view(entry.id);
      const state = replay.kernel.getProcess(entry.id)?.state ?? "unavailable";
      this.host.say(`  ${state === "running" ? "●" : state === "exited" ? "✓" : "○"} ${entry.name}  kernel:${state} orchestration:${view.status}/${view.phase}  ${view.eventCount} events  ${short(view.stateDigest)}  ${entry.id}`);
    }
  }

  private async syscall(rest: string): Promise<void> {
    const [reference, operation, ...argParts] = rest.split("|");
    const entry = this.resolve(reference.trim());
    if (!entry || !operation) {
      this.host.say("usage: /qos syscall <name|id> | <op> | <JSON args>");
      return;
    }
    if (entry.ownerAnchor !== this.host.identity.anchor) {
      this.host.say("only the process owner can issue a canonical syscall");
      return;
    }
    const scope = entry.start.payload.scope as { events?: unknown } | undefined;
    if (!Array.isArray(scope?.events) || !scope.events.includes("syscall-request") || !scope.events.includes("syscall-result")) {
      this.host.say("process root scope does not authorize syscalls");
      return;
    }
    let args: unknown;
    try { args = JSON.parse(argParts.join("|").trim() || "{}"); }
    catch { this.host.say("invalid syscall JSON arguments"); return; }
    const payload = { schema: "qos.syscall/1", caller: entry.id, op: operation.trim(), args };
    const current = () => replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
    const before = current();
    if (args && typeof args === "object" && !Array.isArray(args) &&
        "handle" in args && typeof args.handle === "string" && !Object.hasOwn(args, "handleVersion")) {
      const version = before.kernel.handleVersion(entry.id, args.handle);
      if (version !== undefined) Object.assign(args, { handleVersion: version });
    }
    if (args && typeof args === "object" && !Array.isArray(args) &&
        "target" in args && typeof args.target === "string" && !Object.hasOwn(args, "targetVersion")) {
      const version = before.kernel.processVersion(args.target);
      if (version !== undefined) Object.assign(args, { targetVersion: version });
    }
    if (args && typeof args === "object" && !Array.isArray(args) &&
        SCHEDULER_OPS.includes(operation.trim() as SchedulerOp) && !Object.hasOwn(args,"scheduleFrontier"))
      Object.assign(args,{scheduleFrontier:before.kernel.schedulerFrontier()});
    if (!canonicalSyscallReady(before.kernel, payload, entry.id)) {
      this.host.say("invalid, unsupported or stale canonical syscall");
      return;
    }
    const request = await this.room.emit(entry.id, entry.start, "syscall-request", payload);
    this.host.onSigned?.();
    const requested = current();
    const outcome = previewCanonicalSyscall(requested.kernel, payload, entry.id, request.hash);
    if (!requested.pendingSyscalls.includes(request.hash) || outcome === null) {
      this.host.say("syscall request rejected by canonical replay");
      return;
    }
    const result = await this.room.emit(entry.id, entry.start, "syscall-result", {
      schema: "qos.syscall/1", requestHash: request.hash, outcome,
    });
    this.host.onSigned?.();
    const after = current();
    const trace = after.syscalls.find(item => item.resultHash === result.hash);
    if (!trace) { this.host.say("syscall result rejected by canonical replay"); return; }
    this.host.say(`syscall ${trace.op} ${trace.outcome.ok ? "OK" : trace.outcome.errno} · ${JSON.stringify(trace.outcome)} · position ${trace.position} · kernel digest ${await after.kernel.stateDigest()}`);
  }

  /** OS-style process table is reconstructed from the canonical kernel replay. */
  private async ps(): Promise<void> {
    const replay = replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
    const processes = replay.kernel.list();
    if (processes.length === 0) {
      this.host.say("no replayable QOS processes in this room — start one with `/qos start <name>`");
      if (replay.rejected.length) this.host.say(`  replay rejected ${replay.rejected.length} event(s)`);
      return;
    }
    this.host.say(`QOS process table (${processes.length}) — kernel replay:`);
    this.host.say("  PID | NAME | STATE | EVENTS | OWNER");
    for (const process of processes) {
      const entry = this.byId.get(process.pid);
      const events = this.room.log.eventsFor(process.pid).length;
      const owner = entry ? this.ownerLabel(entry) : process.owner;
      this.host.say(`  ${short(process.pid)} | ${process.name} | ${process.state} | ${events} | ${owner}`);
    }
    if (replay.rejected.length) this.host.say(`  replay rejected ${replay.rejected.length} event(s)`);
    this.host.say("  `/qos kill <name|id>` terminates (owner only).");
  }

  private async lifecycle(verb: "suspend" | "resume" | "terminate", rest: string): Promise<void> {
    const [refPart, ...reasonParts] = rest.split("|");
    const ref = refPart.trim();
    if (!ref) {
      this.host.say(`usage: /qos ${verb} <name|id> [| reason]`);
      return;
    }
    const entry = this.resolve(ref);
    if (!entry) {
      this.host.say(`no process named or identified by **${ref}** — \`/qos status\``);
      return;
    }
    const before = replayQosKernel(this.room.log.events(), this.room.log.forkedSources).kernel.getProcess(entry.id);
    const state = before?.state ?? "unknown";
    const displayState = state === "exited" || state === "reaped" ? "terminated" : state;
    const allowed = verb === "suspend" ? state === "running"
      : verb === "resume" ? state === "suspended"
      : state === "running" || state === "suspended";
    if (!allowed) {
      this.host.say(`cannot ${verb} **${entry.name}** from ${displayState}`);
      return;
    }
    const grant = this.room.findGrant(entry.id, this.host.identity.anchor);
    if (!grant) {
      this.host.say(`only the process owner can ${verb} **${entry.name}**`);
      return;
    }
    const reason = reasonParts.join("|").trim();
    const event = verb === "suspend"
      ? await this.room.suspend(entry.id, grant, reason || undefined)
      : verb === "resume"
        ? await this.room.resume(entry.id, grant, reason || undefined)
        : await this.room.terminate(entry.id, grant, reason || undefined);
    this.host.onSigned?.();
    const after = await this.room.view(entry.id);
    const done = verb === "suspend" ? "suspended" : verb === "resume" ? "resumed" : "terminated";
    this.host.say(`✓ **${entry.name}** ${done} — ${after.status} · ${event.hash.slice(0, 12)}… · digest ${short(after.stateDigest)}`);
  }

  private track(event: QosEvent, owner = event.source): TrackedProcess | null {
    if (event.type !== "process-start") return null;
    const existing = this.byId.get(event.process);
    if (existing) return existing;
    const name = typeof event.payload.name === "string" ? event.payload.name : event.process;
    const entry: TrackedProcess = {
      id: event.process, name, start: event, owner, ownerAnchor: event.source,
    };
    this.byId.set(entry.id, entry);
    if (!this.byName.has(name)) this.byName.set(name, entry.id);
    return entry;
  }

  private resolve(ref: string): TrackedProcess | null {
    const id = this.byId.has(ref) ? ref : this.byName.get(ref);
    return id ? this.byId.get(id) ?? null : null;
  }

  private ownerLabel(entry: TrackedProcess): string {
    return entry.owner === "you" ? "you" : this.label(entry.owner);
  }

  private label(source: string): string {
    return this.host.label?.(source) ?? `${source.slice(0, 12)}…`;
  }
}
