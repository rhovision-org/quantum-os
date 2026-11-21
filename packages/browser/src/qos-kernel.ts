// qos-kernel.ts — QOS/1 kernel ABI v0.
//
// A pure, deterministic model of the kernel objects described in docs/os-abi.md:
// processes, capability handles, rights attenuation, signals, wait/exit, and a
// canonical state digest. It deliberately imports no DOM, storage, network, or
// app code. `qos-process.ts` remains the signed room-event contract; this module
// is the kernel seam that contract will call.
//
// Not implemented here (reserved by the ABI, tracked in the roadmap):
// read/write/stat/VFS, scheduler ticks, devices, services, and the qos.syscall/1
// wire envelope.

import { canonicalJson, canonicalEventOrder, sha256Hex, type QosEvent } from "./qos-process.js";

export const QOS_ABI_VERSION = 0;

export const QOS_RIGHTS = {
  READ: 1,
  WRITE: 2,
  EXEC: 4,
  SIGNAL: 8,
  GRANT: 16,
  REVOKE: 32,
  ADMIN: 64,
} as const;

export type QosRightName = keyof typeof QOS_RIGHTS;
export const QOS_ALL_RIGHTS =
  QOS_RIGHTS.READ | QOS_RIGHTS.WRITE | QOS_RIGHTS.EXEC | QOS_RIGHTS.SIGNAL |
  QOS_RIGHTS.GRANT | QOS_RIGHTS.REVOKE | QOS_RIGHTS.ADMIN;

export const QOS_SYSCALLS = [
  "getpid", "getppid", "spawn", "exit", "wait", "signal",
  "cap_derive", "cap_revoke", "cap_close", "open",
  "read", "write", "stat", "mkdir", "unlink", "rename", "mount", "unmount",
  "send", "recv", "listen", "connect", "accept",
  "svc_register", "svc_lookup", "yield", "sleep", "log",
] as const;
export type QosSyscallName = (typeof QOS_SYSCALLS)[number];

export const QOS_SIGNALS = ["SIGTERM", "SIGINT", "SIGKILL", "SIGCHLD"] as const;
export type QosSignal = (typeof QOS_SIGNALS)[number];

export type QosErrno = "EACCES" | "ENOENT" | "EBADF" | "EAGAIN" | "EINVAL" | "ENOTSUP";

export type QosResult<T> =
  | { ok: true; value: T }
  | { ok: false; errno: QosErrno; detail?: string };

export interface QosHandle {
  readonly id: string;
  readonly object: string;
  readonly rights: number;
  readonly parent: string | null;
  revoked: boolean;
}

export type QosProcessState = "running" | "suspended" | "exited" | "reaped";

export interface QosProcess {
  readonly pid: string;
  readonly name: string;
  readonly owner: string;
  readonly parent: string | null;
  state: QosProcessState;
  exitCode: number | null;
  root: string;
  readonly handles: Map<string, QosHandle>;
  readonly pending: QosSignal[];
}

export interface QosProcessInfo {
  pid: string;
  name: string;
  owner: string;
  parent: string | null;
  state: QosProcessState;
  exitCode: number | null;
  root: string;
  handles: string[];
  pending: QosSignal[];
}

export interface QosHandleInfo {
  id: string;
  object: string;
  rights: number;
  parent: string | null;
  revoked: boolean;
}

const KNOWN_RIGHTS = QOS_ALL_RIGHTS;
const ok = <T>(value: T): QosResult<T> => ({ ok: true, value });
const err = <T = never>(errno: QosErrno, detail?: string): QosResult<T> => ({ ok: false, errno, detail });

function validRights(rights: number): boolean {
  return Number.isInteger(rights) && rights > 0 && (rights & ~KNOWN_RIGHTS) === 0;
}

function signalExitCode(sig: QosSignal): number {
  switch (sig) {
    case "SIGKILL": return -9;
    case "SIGTERM": return -15;
    case "SIGINT": return -2;
    case "SIGCHLD": return 0;
  }
}

/** A deterministic, capability-based kernel object table. */
export class QosKernel {
  private readonly processes = new Map<string, QosProcess>();
  private nextPid = 1;
  private nextHandle = 1;

  /** Bootstrap a process. The caller supplies the owner identity; this is the
   *  equivalent of the room admitting the initial process, not a syscall. */
  createProcess(input: { name: string; owner: string; parent?: string | null; pid?: string }): QosResult<QosProcessInfo> {
    const name = String(input.name ?? "").trim();
    const owner = String(input.owner ?? "").trim();
    if (!name || !owner) return err("EINVAL", "name and owner are required");

    let parent: string | null = input.parent ?? null;
    if (parent !== null) {
      const p = this.processes.get(parent);
      if (!p || p.state !== "running") return err("ENOENT", "parent process is not running");
    }

    const pid = input.pid ?? `proc:${this.nextPid++}`;
    if (this.processes.has(pid)) return err("EINVAL", "pid already exists");

    const rootHandle = this.makeHandle("room", QOS_ALL_RIGHTS, null);
    const proc: QosProcess = {
      pid, name, owner, parent, state: "running", exitCode: null, root: rootHandle.id, handles: new Map(), pending: [],
    };
    proc.handles.set(rootHandle.id, rootHandle);
    this.processes.set(pid, proc);
    return ok(this.info(proc));
  }

  getpid(pid: string): QosResult<string> {
    const p = this.processes.get(pid);
    return p ? ok(p.pid) : err("ENOENT");
  }

  getppid(pid: string): QosResult<string | null> {
    const p = this.processes.get(pid);
    return p ? ok(p.parent) : err("ENOENT");
  }

  /** Spawn a child from an executable image handle. Requires EXEC + GRANT. */
  spawn(callerPid: string, imageHandleId: string, name: string): QosResult<QosProcessInfo> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const image = this.handle(caller, imageHandleId);
    if (!image.ok) return image;
    if (!(image.value.rights & QOS_RIGHTS.EXEC)) return err("EACCES", "image lacks EXEC");
    if (!(image.value.rights & QOS_RIGHTS.GRANT)) return err("EACCES", "image lacks GRANT");
    const label = String(name ?? "").trim();
    if (!label) return err("EINVAL", "name is required");

    const pid = `proc:${this.nextPid++}`;
    // The child's root is a derived image capability, never broader than the image.
    const rootHandle = this.makeHandle(image.value.object, image.value.rights, null);
    const child: QosProcess = {
      pid, name: label, owner: caller.owner, parent: caller.pid,
      state: "running", exitCode: null, root: rootHandle.id, handles: new Map(), pending: [],
    };
    child.handles.set(rootHandle.id, rootHandle);
    this.processes.set(pid, child);
    return ok(this.info(child));
  }

  /** Open a new object handle under a parent handle (default: the root). */
  open(callerPid: string, object: string, rights: number, parentHandleId?: string): QosResult<QosHandleInfo> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const obj = String(object ?? "").trim();
    if (!obj) return err("EINVAL", "object is required");
    if (!validRights(rights)) return err("EINVAL", "rights must be a non-empty known mask");
    const parent = this.handle(caller, parentHandleId ?? caller.root);
    if (!parent.ok) return parent;
    if (!(parent.value.rights & QOS_RIGHTS.GRANT)) return err("EACCES", "parent lacks GRANT");
    if ((rights & ~parent.value.rights) !== 0) return err("EACCES", "cannot widen rights");

    const h = this.makeHandle(obj, rights, parent.value.id);
    caller.handles.set(h.id, h);
    return ok(this.handleInfo(h));
  }

  /** Derive a narrower handle from an existing one. */
  capDerive(callerPid: string, handleId: string, rights: number): QosResult<QosHandleInfo> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    if (!validRights(rights)) return err("EINVAL", "rights must be a non-empty known mask");
    const parent = this.handle(caller, handleId);
    if (!parent.ok) return parent;
    if (!(parent.value.rights & QOS_RIGHTS.GRANT)) return err("EACCES", "handle lacks GRANT");
    if ((rights & ~parent.value.rights) !== 0) return err("EACCES", "cannot widen rights");
    const h = this.makeHandle(parent.value.object, rights, parent.value.id);
    caller.handles.set(h.id, h);
    return ok(this.handleInfo(h));
  }

  /** Close a non-root handle. A closed handle is `EBADF` forever. */
  capClose(callerPid: string, handleId: string): QosResult<true> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    if (handleId === caller.root) return err("EINVAL", "cannot close the root handle");
    const h = caller.handles.get(handleId);
    if (!h) return err("EBADF", "unknown handle");
    if (h.revoked) return err("EACCES", "handle is revoked");
    caller.handles.delete(handleId);
    return ok(true);
  }

  /** Revoke a handle and every descendant handle in every process table. */
  capRevoke(callerPid: string, handleId: string): QosResult<number> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    if (handleId === caller.root) return err("EINVAL", "cannot revoke the root handle");
    const target = caller.handles.get(handleId);
    if (!target) return err("EBADF", "unknown handle");
    if (target.revoked) return err("EACCES", "handle is revoked");
    if (!(target.rights & QOS_RIGHTS.REVOKE) && !(target.rights & QOS_RIGHTS.ADMIN)) {
      return err("EACCES", "handle lacks REVOKE");
    }

    const affected = new Set<string>([handleId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const proc of this.processes.values()) {
        for (const h of proc.handles.values()) {
          if (h.parent && affected.has(h.parent) && !affected.has(h.id)) {
            affected.add(h.id);
            changed = true;
          }
        }
      }
    }
    let count = 0;
    for (const proc of this.processes.values()) {
      for (const id of affected) {
        const h = proc.handles.get(id);
        if (h && !h.revoked) { h.revoked = true; count++; }
      }
    }
    return ok(count);
  }

  /** Apply a trusted, already-validated journal lifecycle transition during replay.
   * This is not a syscall: event admission and authority validation belong to QosEventLog.
   */
  replayLifecycle(pid: string, transition: "suspend" | "resume" | "terminate"): QosResult<true> {
    const target = this.processes.get(pid);
    if (!target) return err("ENOENT", "target does not exist");
    if (transition === "suspend") {
      if (target.state !== "running") return err("EINVAL", "target is not running");
      target.state = "suspended";
      return ok(true);
    }
    if (transition === "resume") {
      if (target.state !== "suspended") return err("EINVAL", "target is not suspended");
      target.state = "running";
      return ok(true);
    }
    if (target.state !== "running" && target.state !== "suspended") return err("EINVAL", "target is not active");
    target.state = "exited";
    target.exitCode = 0;
    target.handles.clear();
    return ok(true);
  }

  /** Send a signal. Self-signalling is allowed; another process requires a
   *  live handle to `proc:<target>` carrying SIGNAL. */
  signal(callerPid: string, targetPid: string, sig: QosSignal): QosResult<true> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const target = this.processes.get(targetPid);
    if (!target) return err("ENOENT", "target does not exist");
    if (target.state !== "running") return err("EINVAL", "target is not running");
    if (!QOS_SIGNALS.includes(sig)) return err("EINVAL", "unknown signal");

    if (callerPid !== targetPid) {
      const hasSignal = [...caller.handles.values()].some(
        (h) => !h.revoked && (h.rights & QOS_RIGHTS.SIGNAL) && h.object === `proc:${targetPid}`,
      );
      if (!hasSignal) return err("EACCES", "no SIGNAL handle for target");
    }

    target.pending.push(sig);
    if (sig !== "SIGCHLD") {
      target.state = "exited";
      target.exitCode = signalExitCode(sig);
    }
    return ok(true);
  }

  /** Wait for a direct child. Running → EAGAIN; already reaped → ENOENT. */
  wait(callerPid: string, childPid: string): QosResult<number> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const child = this.processes.get(childPid);
    if (!child) return err("ENOENT", "child does not exist");
    if (child.parent !== callerPid) return err("EACCES", "not the parent");
    if (child.state === "reaped") return err("ENOENT", "child already reaped");
    if (child.state === "running") return err("EAGAIN", "child still running");
    const code = child.exitCode ?? 0;
    child.state = "reaped";
    child.handles.clear();
    return ok(code);
  }

  /** Exit the caller. Its handles do not outlive it. */
  exit(callerPid: string, code = 0): QosResult<true> {
    const p = this.processes.get(callerPid);
    if (!p) return err("ENOENT", "process does not exist");
    if (p.state !== "running") return err("EINVAL", "process is not running");
    if (!Number.isInteger(code)) return err("EINVAL", "exit code must be an integer");
    p.state = "exited";
    p.exitCode = code;
    p.handles.clear();
    return ok(true);
  }

  getProcess(pid: string): QosProcessInfo | null {
    const p = this.processes.get(pid);
    return p ? this.info(p) : null;
  }

  list(): QosProcessInfo[] {
    return [...this.processes.values()].map((p) => this.info(p)).sort((a, b) => a.pid.localeCompare(b.pid));
  }

  /** Canonical state used by the digest. Only stable, sorted data. */
  state(): Record<string, unknown> {
    return {
      abi: QOS_ABI_VERSION,
      nextPid: this.nextPid,
      nextHandle: this.nextHandle,
      processes: [...this.processes.values()]
        .sort((a, b) => a.pid.localeCompare(b.pid))
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          owner: p.owner,
          parent: p.parent,
          state: p.state,
          exitCode: p.exitCode,
          root: p.root,
          pending: [...p.pending],
          handles: [...p.handles.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((h) => ({ id: h.id, object: h.object, rights: h.rights, parent: h.parent, revoked: h.revoked })),
        })),
    };
  }

  async stateDigest(): Promise<string> {
    return sha256Hex(canonicalJson(this.state()));
  }

  private makeHandle(object: string, rights: number, parent: string | null): QosHandle {
    return { id: `h:${this.nextHandle++}`, object, rights, parent, revoked: false };
  }

  private handle(proc: QosProcess, id: string): QosResult<QosHandle> {
    const h = proc.handles.get(id);
    if (!h) return err("EBADF", "unknown handle");
    if (h.revoked) return err("EACCES", "handle is revoked");
    return ok(h);
  }

  private handleInfo(h: QosHandle): QosHandleInfo {
    return { id: h.id, object: h.object, rights: h.rights, parent: h.parent, revoked: h.revoked };
  }

  private info(p: QosProcess): QosProcessInfo {
    return {
      pid: p.pid,
      name: p.name,
      owner: p.owner,
      parent: p.parent,
      state: p.state,
      exitCode: p.exitCode,
      root: p.root,
      handles: [...p.handles.keys()].sort((a, b) => a.localeCompare(b)),
      pending: [...p.pending],
    };
  }
}

export interface QosKernelReplayResult {
  kernel: QosKernel;
  applied: string[];
  rejected: { hash: string; reason: string }[];
  missingDependencies: { eventHash: string; dependencyHash: string; kind: "prev" | "grant" }[];
  cyclicHashes: string[];
}

/** Reconstruct the kernel process table from a verified qos.event/1 event set.
 * Input admission (hash/dyncap/fork verification) must happen before this call.
 * The replay is deterministic for any delivery permutation of the same event set.
 */
export function replayQosKernel(events: QosEvent[], forkedSources: Iterable<string> = []): QosKernelReplayResult {
  const forked = new Set(forkedSources);
  const admitted = events.filter((event) => !forked.has(event.source));
  const order = canonicalEventOrder(admitted);
  const kernel = new QosKernel();
  const starts = new Map<string, QosEvent>();
  const invalidEventHashes = new Set(order.missingDependencies.map((item) => item.eventHash));
  for (const hash of order.cyclicHashes) invalidEventHashes.add(hash);
  // Fail closed transitively: an event whose prev/grant points to an invalid
  // event is itself invalid, even if its direct references are present.
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of order.ordered) {
      if (invalidEventHashes.has(event.hash)) continue;
      const refs = [event.prev !== "genesis" ? event.prev : null, event.grant !== "root" ? event.grant : null].filter(Boolean) as string[];
      if (refs.some((ref) => invalidEventHashes.has(ref))) {
        invalidEventHashes.add(event.hash);
        changed = true;
      }
    }
  }
  const applied: string[] = [];
  const rejected: { hash: string; reason: string }[] = [];
  for (const event of order.ordered) {
    if (invalidEventHashes.has(event.hash)) {
      rejected.push({ hash: event.hash, reason: "event has unresolved or cyclic causal dependencies" });
      continue;
    }
    if (event.type === "process-start") {
      const name = typeof event.payload.name === "string" ? event.payload.name : event.process;
      const result = kernel.createProcess({ name, owner: event.source, pid: event.process });
      if (!result.ok) rejected.push({ hash: event.hash, reason: result.detail ?? result.errno });
      else { starts.set(event.process, event); applied.push(event.hash); }
      continue;
    }
    if (event.type !== "process-suspend" && event.type !== "process-resume" && event.type !== "process-terminate") continue;
    const start = starts.get(event.process);
    if (!start) { rejected.push({ hash: event.hash, reason: "lifecycle event precedes or lacks process-start" }); continue; }
    if (event.source !== start.source || event.capability !== start.capability) {
      rejected.push({ hash: event.hash, reason: "lifecycle event is not root-attributed" });
      continue;
    }
    const transition = event.type === "process-suspend" ? "suspend" : event.type === "process-resume" ? "resume" : "terminate";
    const result = kernel.replayLifecycle(event.process, transition);
    if (!result.ok) rejected.push({ hash: event.hash, reason: result.detail ?? result.errno });
    else applied.push(event.hash);
  }
  return { kernel, applied, rejected, missingDependencies: order.missingDependencies, cyclicHashes: order.cyclicHashes };
}
