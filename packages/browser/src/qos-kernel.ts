// qos-kernel.ts — QOS/1 kernel ABI v0.
//
// A pure, deterministic model of the kernel objects described in docs/os-abi.md:
// processes, capability handles, rights attenuation, signals, wait/exit, and a
// canonical state digest. It deliberately imports no DOM, storage, network, or
// app code. `qos-process.ts` remains the dyncap-attributed room-event contract; this module
// is the kernel seam that contract will call.
//
// Not implemented here (reserved by the ABI, tracked in the roadmap):
// read/write/stat/VFS, devices, services, and broader syscall
// authority. The bounded root-attributed syscall event slice is below.

import { canonicalJson, canonicalEventOrder, eventDependencies, type QosDependencyKind, brokenChainsIn, processIdFor, parseQosCapabilityScope, scopeAllows, sha256Hex, type QosEvent } from "./qos-process.js";

import { QosScheduler, SCHEDULER_OPS, MAX_SCHEDULER_FRONTIER, type SchedulerOp, type ScheduleView } from "./qos-scheduler.js";

import { QosMemoryGraph, MEMORY_OPS, MAX_MEMORY_FRONTIER, parseDescriptor, type MemoryOp, type MemoryObject, type ObjectDescriptor } from "./qos-memory.js";

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
  "cap_derive", "cap_revoke", "cap_close", "signal_grant", "open", ...MEMORY_OPS,
  "read", "write", "stat", "mkdir", "unlink", "rename", "mount", "unmount",
  "send", "recv", "listen", "connect", "accept",
  "svc_register", "svc_lookup", "yield", "sleep", "sched_step", "sched_priority", "sched_wake", "log",
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
  return Number.isInteger(rights) && rights > 0 && rights <= KNOWN_RIGHTS && (rights & ~KNOWN_RIGHTS) === 0;
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
  private scheduler = new QosScheduler();
  private memory = new QosMemoryGraph();

  private memoryRoots(): string[] {
    const roots = new Set<string>();
    for (const p of this.processes.values()) for (const h of p.handles.values())
      if (!h.revoked && h.object.startsWith("mem:")) roots.add(h.object.slice(4));
    return [...roots].sort();
  }
  memoryView() { return this.memory.state(this.memoryRoots()); }
  memoryFrontier(): string[] { return this.memory.frontier(); }
  recordMemory(before: string, eventHash:string, operation?: MemoryOp):void {
    if (operation && operation !== "mem_get" && operation !== "mem_stat") this.memory.commit(eventHash);
    else if (before !== canonicalJson(this.memoryRoots())) this.memory.observe(eventHash);
  }
  memoryRootSnapshot():string { return canonicalJson(this.memoryRoots()); }

  /** A put declares immutable content metadata; it does not certify byte availability. */
  memoryPut(pid:string, rootId:string, descriptor:ObjectDescriptor, allocation:string):QosResult<QosHandleInfo> {
    const caller=this.processes.get(pid);
    if (!caller || caller.state!=="running") return err("ENOENT","caller is not running");
    if (caller.root!==rootId) return err("EACCES","namespace root required");
    const root=this.handle(caller,rootId);
    if (!root.ok) return root;
    const rights=QOS_RIGHTS.READ|QOS_RIGHTS.WRITE|QOS_RIGHTS.GRANT|QOS_RIGHTS.REVOKE;
    if ((root.value.rights & rights)!==rights) return err("EACCES","root lacks memory rights");
    const id=`h:memory:${allocation}`;
    if (this.lineage.has(id)) return err("EINVAL","handle already allocated");
    const validated=parseDescriptor(descriptor);
    if (!validated || !this.memory.put(validated)) return err("EINVAL","invalid or conflicting content descriptor");
    const h=this.makeHandle("mem:"+descriptor.id,rights,rootId,id);
    caller.handles.set(h.id,h);
    return ok(this.handleInfo(h));
  }

  private memoryHandle(pid:string,id:string,right:number):QosResult<QosHandle> {
    const caller=this.processes.get(pid);
    if (!caller || caller.state!=="running") return err("ENOENT","caller is not running");
    const h=this.handle(caller,id);
    if(!h.ok)return h;
    if(!h.value.object.startsWith("mem:") || (h.value.rights & right)!==right) return err("EACCES","memory handle or right missing");
    return h;
  }
  memoryStat(pid:string,id:string):QosResult<MemoryObject> {
    const h=this.memoryHandle(pid,id,QOS_RIGHTS.READ);
    if(!h.ok)return h;
    const d=this.memory.stat(h.value.object.slice(4));
    return d?ok(d):err("ENOENT","object metadata absent");
  }
  memoryRef(pid:string,id:string,rights:number,allocation:string):QosResult<QosHandleInfo> {
    const h=this.memoryHandle(pid,id,QOS_RIGHTS.GRANT);
    return h.ok?this.capDerive(pid,id,rights,`h:memory:${allocation}`):h;
  }
  memoryDrop(pid:string,id:string):QosResult<true> {
    const h=this.memoryHandle(pid,id,0);
    return h.ok?this.capClose(pid,id):h;
  }
  memoryLink(pid:string,from:string,to:string,remove:boolean):QosResult<true> {
    const a=this.memoryHandle(pid,from,QOS_RIGHTS.WRITE),b=this.memoryHandle(pid,to,QOS_RIGHTS.READ);
    if(!a.ok)return a;if(!b.ok)return b;
    return this.memory.link(pid,a.value.object.slice(4),b.value.object.slice(4),remove)?ok(true):err("ENOENT","object metadata absent");
  }

  scheduleView(): ScheduleView { return this.scheduler.view(); }
  schedulerFrontier(): string[] { return this.scheduler.frontier(); }
  schedulerTurn(pid: string, op: SchedulerOp, amount?: number): QosResult<ScheduleView> {
    return this.scheduler.turn(pid, op, amount);
  }
  recordScheduler(eventHash: string, turn = false): void {
    const changed = this.scheduler.sync(this.list());
    if (turn) this.scheduler.commitTurn(eventHash);
    else if (changed) this.scheduler.observe(eventHash);
  }

  private nextPid = 1;
  private nextHandle = 1;
  // Closed handles are removed from the live table but their ancestry remains
  // part of the replay state; a close must not cut a revocation path.
  private readonly lineage = new Map<string, string | null>();
  // Version stamps are canonical event hashes, including tombstone versions.
  private readonly versions = new Map<string, { pid: string; hash: string }>();
  private readonly processVersions = new Map<string, string>();

  processVersion(pid: string): string | undefined { return this.processVersions.get(pid); }

  snapshotProcessState(): Map<string, string> {
    return new Map([...this.processes].map(([pid, p]) =>
      [pid, canonicalJson([p.state, p.exitCode, p.pending])]));
  }

  recordProcessVersions(before: Map<string, string>, eventHash: string): void {
    for (const [pid, value] of this.snapshotProcessState())
      if (before.get(pid) !== value) this.processVersions.set(pid, eventHash);
  }

  /** Do not expose another process's handle version through this lookup. */
  handleVersion(pid: string, handle: string): string | undefined {
    const version = this.versions.get(handle);
    return version?.pid === pid ? version.hash : undefined;
  }

  snapshotLiveHandles(): Map<string, { pid: string; revoked: boolean }> {
    const out = new Map<string, { pid: string; revoked: boolean }>();
    for (const p of this.processes.values()) for (const h of p.handles.values())
      out.set(h.id, { pid: p.pid, revoked: h.revoked });
    return out;
  }

  /** Stamp creations, closures and revocations only after verified replay. */
  recordHandleVersions(before: Map<string, { pid: string; revoked: boolean }>, eventHash: string): void {
    const after = this.snapshotLiveHandles();
    for (const [id, current] of after) {
      const prior = before.get(id);
      if (!prior || prior.pid !== current.pid || prior.revoked !== current.revoked)
        this.versions.set(id, { pid: current.pid, hash: eventHash });
    }
    for (const [id, prior] of before) if (!after.has(id))
      this.versions.set(id, { pid: prior.pid, hash: eventHash });
  }

  /** Bootstrap a process. The caller supplies the owner identity; this is the
   *  equivalent of the room admitting the initial process, not a syscall. */
  createProcess(input: { name: string; owner: string; parent?: string | null; pid?: string; rootId?: string }): QosResult<QosProcessInfo> {
    const name = String(input.name ?? "").trim();
    const owner = String(input.owner ?? "").trim();
    if (!name || !owner) return err("EINVAL", "name and owner are required");

    let parent: string | null = input.parent ?? null;
    if (parent !== null) {
      const p = this.processes.get(parent);
      if (!p || p.state !== "running") return err("ENOENT", "parent process is not running");
    }

    const pid = input.pid ?? this.allocatePid();
    if (this.processes.has(pid)) return err("EINVAL", "pid already exists");

    if (input.rootId !== undefined && this.lineage.has(input.rootId)) return err("EINVAL", "handle ID already allocated");
    const rootHandle = this.makeHandle("room", QOS_ALL_RIGHTS, null, input.rootId);
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

    const pid = this.allocatePid();
    // The child's root is a derived image capability, never broader than the image.
    const rootHandle = this.makeHandle(image.value.object, image.value.rights, image.value.id);
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
  capDerive(callerPid: string, handleId: string, rights: number, allocatedId?: string): QosResult<QosHandleInfo> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    if (!validRights(rights)) return err("EINVAL", "rights must be a non-empty known mask");
    const parent = this.handle(caller, handleId);
    if (!parent.ok) return parent;
    if (!(parent.value.rights & QOS_RIGHTS.GRANT)) return err("EACCES", "handle lacks GRANT");
    if ((rights & ~parent.value.rights) !== 0) return err("EACCES", "cannot widen rights");
    if (allocatedId !== undefined && this.lineage.has(allocatedId)) return err("EINVAL", "handle ID already allocated");
    const h = this.makeHandle(parent.value.object, rights, parent.value.id, allocatedId);
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

    const children = new Map<string, string[]>();
    for (const [id, parent] of this.lineage) {
      if (parent === null) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(id);
      children.set(parent, siblings);
    }
    const affected = new Set<string>([handleId]);
    const queue = [handleId];
    for (let i = 0; i < queue.length; i++) {
      for (const child of children.get(queue[i]) ?? []) {
        if (!affected.has(child)) { affected.add(child); queue.push(child); }
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

  /** Target-owner consent: grant only SIGNAL over oneself, with a revoker
   * retained by the target. No generic room-root open is exposed by replay. */
  grantSignal(targetPid: string, rootId: string, recipientPid: string, allocation: string): QosResult<{ revoker: QosHandleInfo; handle: QosHandleInfo }> {
    const target = this.processes.get(targetPid), recipient = this.processes.get(recipientPid);
    if (!target || target.state !== "running" || !recipient || recipient.state !== "running")
      return err("ENOENT", "grant requires two running processes");
    if (targetPid === recipientPid) return err("EINVAL", "recipient must be another process");
    if (target.root !== rootId) return err("EACCES", "target root required");
    const root = this.handle(target, rootId);
    if (!root.ok) return root;
    if ((root.value.rights & (QOS_RIGHTS.GRANT | QOS_RIGHTS.SIGNAL | QOS_RIGHTS.REVOKE)) !==
        (QOS_RIGHTS.GRANT | QOS_RIGHTS.SIGNAL | QOS_RIGHTS.REVOKE))
      return err("EACCES", "root lacks grant authority");
    const revokerId = `h:signal-revoker:${allocation}`, handleId = `h:signal:${allocation}`;
    if (this.lineage.has(revokerId) || this.lineage.has(handleId)) return err("EINVAL", "grant already allocated");
    const object = `proc:${targetPid}`;
    const revoker = this.makeHandle(object, QOS_RIGHTS.SIGNAL | QOS_RIGHTS.REVOKE, rootId, revokerId);
    const handle = this.makeHandle(object, QOS_RIGHTS.SIGNAL, revoker.id, handleId);
    target.handles.set(revoker.id, revoker);
    recipient.handles.set(handle.id, handle);
    return ok({ revoker: this.handleInfo(revoker), handle: this.handleInfo(handle) });
  }

  /** Send a signal. Self-signalling is allowed; another process requires a
   *  live handle to `proc:<target>` carrying SIGNAL. */
  signal(callerPid: string, targetPid: string, sig: QosSignal, explicitHandle?: string): QosResult<true> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const target = this.processes.get(targetPid);
    if (!target) return err("ENOENT", "target does not exist");
    if (target.state !== "running" && target.state !== "suspended") return err("EINVAL", "target is not active");
    if (!QOS_SIGNALS.includes(sig)) return err("EINVAL", "unknown signal");
    if (sig === "SIGKILL" && caller.owner !== target.owner) return err("EACCES", "SIGKILL is target-owner only");

    if (callerPid === targetPid && explicitHandle !== undefined) {
      const h = this.handle(caller, explicitHandle);
      if (!h.ok || !(h.value.rights & QOS_RIGHTS.SIGNAL)) return err("EACCES", "self signal requires live SIGNAL authority");
    }
    if (callerPid !== targetPid) {
      const candidates = explicitHandle === undefined ? [...caller.handles.values()] : [caller.handles.get(explicitHandle)];
      const hasSignal = candidates.some(
        (h) => h && !h.revoked && (h.rights & QOS_RIGHTS.SIGNAL) && h.object === `proc:${targetPid}`,
      );
      if (!hasSignal) return err("EACCES", "no SIGNAL handle for target");
    }

    target.pending.push(sig);
    if (sig !== "SIGCHLD") {
      target.state = "exited";
      target.exitCode = signalExitCode(sig);
      target.handles.clear();
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
    if (child.state === "running" || child.state === "suspended") return err("EAGAIN", "child still active");
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
    return [...this.processes.values()].map((p) => this.info(p)).sort((a, b) => a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0);
  }

  /** Copy every replay-relevant field, including allocation counters.
   * A speculative operation must never mutate the committed kernel. */
  cloneForReplay(): QosKernel {
    const copy = new QosKernel();
    copy.scheduler = this.scheduler.clone();
    copy.memory = this.memory.clone();
    copy.nextPid = this.nextPid;
    copy.nextHandle = this.nextHandle;
    for (const [id, parent] of this.lineage) copy.lineage.set(id, parent);
    for (const [id, version] of this.versions) copy.versions.set(id, { ...version });
    for (const [pid, version] of this.processVersions) copy.processVersions.set(pid, version);
    for (const [pid, proc] of this.processes) {
      copy.processes.set(pid, {
        ...proc,
        pending: [...proc.pending],
        handles: new Map([...proc.handles].map(([id, handle]) => [id, { ...handle }])),
      });
    }
    return copy;
  }

  /** Canonical state used by the digest. Only stable, sorted data. */
  state(): Record<string, unknown> {
    return {
      abi: QOS_ABI_VERSION,
      scheduler: this.scheduler.state(),
      memory: this.memoryView(),
      nextPid: this.nextPid,
      nextHandle: this.nextHandle,
      processVersions: [...this.processVersions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      versions: [...this.versions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, v]) => [id, { ...v }]),
      lineage: [...this.lineage.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      processes: [...this.processes.values()]
        .sort((a, b) => a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0)
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
            .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            .map((h) => ({ id: h.id, object: h.object, rights: h.rights, parent: h.parent, revoked: h.revoked })),
        })),
    };
  }

  async stateDigest(): Promise<string> {
    return sha256Hex(canonicalJson(this.state()));
  }

  private allocatePid(): string {
    let pid: string;
    do { pid = `proc:${this.nextPid++}`; } while (this.processes.has(pid));
    return pid;
  }

  private makeHandle(object: string, rights: number, parent: string | null, stableId?: string): QosHandle {
    let id: string;
    if (stableId !== undefined) id = stableId;
    else { do { id = `h:${this.nextHandle++}`; } while (this.lineage.has(id)); }
    this.lineage.set(id, parent);
    return { id, object, rights, parent, revoked: false };
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
      handles: [...p.handles.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      pending: [...p.pending],
    };
  }
}

/** Embedded payload only; no independent syscall stream. */
export type QosCanonicalSyscallRequest = {
  schema: "qos.syscall/1";
  caller: string;
  op: "getpid" | "getppid" | "cap_derive" | "cap_close" | "cap_revoke" | "signal_grant" | "signal" | SchedulerOp | MemoryOp;
  args: Record<string, unknown>;
};
export type QosCanonicalSyscallTrace = {
  requestHash: string;
  resultHash: string;
  caller: string;
  op: QosCanonicalSyscallRequest["op"];
  args: Record<string, unknown>;
  outcome: QosResult<unknown>;
  position: number;
};
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function parseSyscallRequest(payload: Record<string, unknown>, pid: string): QosCanonicalSyscallRequest | null {
  if (!exactKeys(payload, ["schema", "caller", "op", "args"]) ||
      payload.schema !== "qos.syscall/1" || payload.caller !== pid) return null;
  const args = payload.args;
  switch (payload.op) {
    case "getpid": case "getppid":
      if (!exactKeys(args, [])) return null;
      break;
    case "cap_close": case "cap_revoke":
    case "cap_derive": {
      const keys = payload.op === "cap_derive" ? ["handle", "rights"] : ["handle"];
      if (args && typeof args === "object" && Object.hasOwn(args, "handleVersion")) keys.push("handleVersion");
      if (!exactKeys(args, keys) || typeof args.handle !== "string") return null;
      if (keys.includes("handleVersion") && (typeof args.handleVersion !== "string" || !/^[0-9a-f]{64}$/.test(args.handleVersion))) return null;
      if (payload.op === "cap_derive" && (typeof args.rights !== "number" || !Number.isSafeInteger(args.rights))) return null;
      break;
    }
    case "signal_grant":
    case "signal": {
      const keys = payload.op === "signal_grant"
        ? ["handle", "handleVersion", "target", "targetVersion"]
        : ["handle", "target", "targetVersion", "signal"];
      if (payload.op === "signal" && args && typeof args === "object" && Object.hasOwn(args, "handleVersion")) keys.push("handleVersion");
      if (!exactKeys(args, keys) || typeof args.handle !== "string" ||
          typeof args.target !== "string" || typeof args.targetVersion !== "string" ||
          !/^[0-9a-f]{64}$/.test(args.targetVersion)) return null;
      if (keys.includes("handleVersion") && (typeof args.handleVersion !== "string" || !/^[0-9a-f]{64}$/.test(args.handleVersion))) return null;
      if (payload.op === "signal" && !QOS_SIGNALS.includes(args.signal as QosSignal)) return null;
      break;
    }
    case "sched_step": case "yield": case "sleep": case "sched_priority": case "sched_wake": {
      const keys = ["scheduleFrontier"];
      if (payload.op === "sleep") keys.push("ticks");
      if (payload.op === "sched_priority") keys.push("priority");
      if (!exactKeys(args, keys) || !Array.isArray(args.scheduleFrontier) ||
          args.scheduleFrontier.length === 0 || args.scheduleFrontier.length > MAX_SCHEDULER_FRONTIER ||
          !args.scheduleFrontier.every((v,i,a) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) && (i === 0 || a[i-1] < v))) return null;
      if (payload.op === "sleep" && (typeof args.ticks !== "number" || !Number.isSafeInteger(args.ticks))) return null;
      if (payload.op === "sched_priority" && (typeof args.priority !== "number" || !Number.isSafeInteger(args.priority))) return null;
      break;
    }
    case "mem_put": case "mem_get": case "mem_stat": case "mem_ref": case "mem_drop": case "mem_link": case "mem_unlink": {
      const keys=["handle","memoryFrontier"];
      if(args && typeof args==="object" && Object.hasOwn(args,"handleVersion"))keys.push("handleVersion");
      if(payload.op==="mem_put")keys.push("descriptor");
      if(payload.op==="mem_ref")keys.push("rights");
      if(payload.op==="mem_link"||payload.op==="mem_unlink")keys.push("targetHandle","targetHandleVersion");
      if(!exactKeys(args,keys)||typeof args.handle!=="string"||
         !Array.isArray(args.memoryFrontier)||args.memoryFrontier.length>MAX_MEMORY_FRONTIER||
         !args.memoryFrontier.every((v,i,a)=>typeof v==="string"&&/^[0-9a-f]{64}$/.test(v)&&(i===0||a[i-1]<v)))return null;
      if(keys.includes("handleVersion")&&(typeof args.handleVersion!=="string"||!/^[0-9a-f]{64}$/.test(args.handleVersion)))return null;
      if(payload.op==="mem_put"&&!parseDescriptor(args.descriptor))return null;
      if(payload.op==="mem_ref"&&(typeof args.rights!=="number"||!Number.isSafeInteger(args.rights)))return null;
      if(keys.includes("targetHandle")&&(typeof args.targetHandle!=="string"||typeof args.targetHandleVersion!=="string"||!/^[0-9a-f]{64}$/.test(args.targetHandleVersion)))return null;
      break;
    }
    default: return null;
  }
  return payload as QosCanonicalSyscallRequest;
}
function executeCanonicalSyscall(kernel: QosKernel, request: QosCanonicalSyscallRequest, requestHash?: string): QosResult<unknown> {
  const pid = request.caller;
  if (kernel.getProcess(pid)?.state !== "running") return err("ENOENT", "caller is not running");
  switch (request.op) {
    case "sched_step": case "yield": case "sched_wake": return kernel.schedulerTurn(pid, request.op);
    case "sleep": return kernel.schedulerTurn(pid, request.op, request.args.ticks as number);
    case "sched_priority": return kernel.schedulerTurn(pid, request.op, request.args.priority as number);
    case "mem_put": return requestHash===undefined?err("EINVAL","request hash required"):kernel.memoryPut(pid,request.args.handle as string,parseDescriptor(request.args.descriptor)!,requestHash);
    case "mem_get": case "mem_stat": return kernel.memoryStat(pid,request.args.handle as string);
    case "mem_ref": return requestHash===undefined?err("EINVAL","request hash required"):kernel.memoryRef(pid,request.args.handle as string,request.args.rights as number,requestHash);
    case "mem_drop": return kernel.memoryDrop(pid,request.args.handle as string);
    case "mem_link": case "mem_unlink": return kernel.memoryLink(pid,request.args.handle as string,request.args.targetHandle as string,request.op==="mem_unlink");
    case "getpid": return kernel.getpid(pid);
    case "getppid": return kernel.getppid(pid);
    case "cap_derive": return kernel.capDerive(pid, request.args.handle as string, request.args.rights as number, requestHash === undefined ? undefined : `h:request:${requestHash}`);
    case "cap_close": return kernel.capClose(pid, request.args.handle as string);
    case "cap_revoke": return kernel.capRevoke(pid, request.args.handle as string);
    case "signal_grant": return requestHash === undefined ? err("EINVAL", "request hash required") :
      kernel.grantSignal(pid, request.args.handle as string, request.args.target as string, requestHash);
    case "signal": {
      const target = request.args.target as string;
      // Canonical self-signals use the caller root, never a guessed handle.
      if (target === pid && request.args.handle !== kernel.getProcess(pid)?.root)
        return err("EACCES", "self signal requires root");
      return kernel.signal(pid, target, request.args.signal as QosSignal, request.args.handle as string);
    }
  }
}
function syscallVersionsMatch(kernel: QosKernel, request: QosCanonicalSyscallRequest): boolean {
  const args = request.args, pid = request.caller;
  if (SCHEDULER_OPS.includes(request.op as SchedulerOp))
    return canonicalJson(args.scheduleFrontier) === canonicalJson(kernel.schedulerFrontier());
  if (typeof args.handle === "string" && args.handleVersion !== kernel.handleVersion(pid, args.handle)) return false;
  if(MEMORY_OPS.includes(request.op as MemoryOp)){
    if(canonicalJson(args.memoryFrontier)!==canonicalJson(kernel.memoryFrontier()))return false;
    if(typeof args.targetHandle==="string"&&args.targetHandleVersion!==kernel.handleVersion(pid,args.targetHandle))return false;
  }
  if (request.op === "signal" || request.op === "signal_grant")
    return args.targetVersion === kernel.processVersion(args.target as string);
  return true;
}

/** Preflight for the command adapter; malformed/stale requests must not poison its chain. */
export function canonicalSyscallReady(kernel: QosKernel, payload: Record<string, unknown>, pid: string): boolean {
  const request = parseSyscallRequest(payload, pid);
  return request !== null && syscallVersionsMatch(kernel, request);
}

/** Predict the outcome without changing the source kernel. */
export function previewCanonicalSyscall(kernel: QosKernel, payload: Record<string, unknown>, pid: string, requestHash?: string): QosResult<unknown> | null {
  const request = parseSyscallRequest(payload, pid);
  return request ? executeCanonicalSyscall(kernel.cloneForReplay(), request, requestHash) : null;
}

export interface QosKernelReplayResult {
  kernel: QosKernel;
  applied: string[];
  rejected: { hash: string; reason: string }[];
  missingDependencies: { eventHash: string; dependencyHash: string; kind: QosDependencyKind }[];
  cyclicHashes: string[];
  syscalls: QosCanonicalSyscallTrace[];
  pendingSyscalls: string[];
}

/** Reconstruct the kernel process table from a verified qos.event/1 event set.
 * Input admission (hash/dyncap/fork verification) must happen before this call.
 * The replay is deterministic for any delivery permutation of the same event set.
 */
export function replayQosKernel(events: QosEvent[], forkedSources: Iterable<string> = []): QosKernelReplayResult {
  const forked = new Set(forkedSources);
  const admitted = events.filter((event) => !forked.has(event.source));
  const order = canonicalEventOrder(admitted);
  const broken = brokenChainsIn(admitted);
  let kernel = new QosKernel();
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
      const refs = eventDependencies(event).map(ref => ref.hash);
      if (refs.some((ref) => invalidEventHashes.has(ref))) {
        invalidEventHashes.add(event.hash);
        changed = true;
      }
    }
  }
  const applied: string[] = [];
  const syscalls: QosCanonicalSyscallTrace[] = [];
  const requests = new Map<string, { event: QosEvent; request: QosCanonicalSyscallRequest }>();
  const consumed = new Set<string>();
  const startCounts = new Map<string, number>();
  for (const event of order.ordered) {
    if (event.type === "process-start") startCounts.set(event.process, (startCounts.get(event.process) ?? 0) + 1);
  }
  const rejected: { hash: string; reason: string }[] = [];
  const rejectSyscall = (event: QosEvent, reason: string) => {
    invalidEventHashes.add(event.hash);
    rejected.push({ hash: event.hash, reason });
  };
  for (const [position, event] of order.ordered.entries()) {
    if (invalidEventHashes.has(event.hash) || eventDependencies(event).some(ref => invalidEventHashes.has(ref.hash))) {
      invalidEventHashes.add(event.hash);
      rejected.push({ hash: event.hash, reason: "event has unresolved or cyclic causal dependencies" });
      continue;
    }
    if (event.type === "process-start") {
      const name = event.payload.name;
      const scope = parseQosCapabilityScope(event.payload.scope);
      if (startCounts.get(event.process) !== 1 || event.prev !== "genesis" || event.grant !== "root" ||
          typeof name !== "string" || event.payload.rootCapability !== event.capability ||
          processIdFor(name, event.capability) !== event.process || !scope || scope.process !== event.process) {
        rejectSyscall(event, "conflicting or invalid process-start"); continue;
      }
      const before = kernel.snapshotLiveHandles();
      const beforeMemory = kernel.memoryRootSnapshot();
      const beforeProcesses = kernel.snapshotProcessState();
      const result = kernel.createProcess({ name, owner: event.source, pid: event.process, rootId: `h:start:${event.hash}` });
      if (!result.ok) rejectSyscall(event, result.detail ?? result.errno);
      else { kernel.recordHandleVersions(before, event.hash); kernel.recordProcessVersions(beforeProcesses, event.hash); kernel.recordScheduler(event.hash); kernel.recordMemory(beforeMemory,event.hash); starts.set(event.process, event); applied.push(event.hash); }
      continue;
    }
    if (event.type === "syscall-request" || event.type === "syscall-result") {
      const start = starts.get(event.process);
      const scope = start?.payload.scope as { process?: unknown; events?: unknown } | undefined;
      if (!start || startCounts.get(event.process) !== 1 || event.grant !== "root" ||
          broken.some(chain => chain.process === event.process && chain.source === event.source) ||
          event.source !== start.source || event.capability !== start.capability ||
          start.payload.rootCapability !== start.capability || scope?.process !== event.process ||
          !Array.isArray(scope.events) || !scope.events.includes(event.type)) {
        rejectSyscall(event, "syscall event lacks explicit process-root authority"); continue;
      }
      if (event.type === "syscall-request") {
        const request = parseSyscallRequest(event.payload, event.process);
        if (!request) { rejectSyscall(event, "invalid or unsupported syscall payload"); continue; }
        if (!syscallVersionsMatch(kernel, request)) {
          rejectSyscall(event, "missing, stale or foreign handle/process/scheduler/memory version"); continue;
        }
        requests.set(event.hash, { event, request });
        applied.push(event.hash);
        continue;
      }
      const payload = event.payload;
      const requestHash = payload.requestHash;
      const pending = typeof requestHash === "string" ? requests.get(requestHash) : undefined;
      if (!exactKeys(payload, ["schema", "requestHash", "outcome"]) ||
          payload.schema !== "qos.syscall/1" || typeof requestHash !== "string" ||
          requestHash !== event.prev || !pending || consumed.has(requestHash) ||
          pending.event.process !== event.process || pending.event.source !== event.source ||
          pending.event.capability !== event.capability) {
        rejectSyscall(event, "unmatched or repeated syscall result"); continue;
      }
      if (!syscallVersionsMatch(kernel, pending.request)) {
        rejectSyscall(event, "handle/process/scheduler/memory version changed before result"); continue;
      }
      const before = kernel.snapshotLiveHandles();
      const beforeMemory = kernel.memoryRootSnapshot();
      const beforeProcesses = kernel.snapshotProcessState();
      const trial = kernel.cloneForReplay();
      const outcome = executeCanonicalSyscall(trial, pending.request, requestHash);
      if (canonicalJson(outcome) !== canonicalJson(payload.outcome)) {
        rejectSyscall(event, "syscall outcome differs from deterministic execution"); continue;
      }
      // Refusals are traceable but cannot publish speculative mutation.
      if (outcome.ok) { trial.recordHandleVersions(before, event.hash); trial.recordProcessVersions(beforeProcesses, event.hash); trial.recordScheduler(event.hash, SCHEDULER_OPS.includes(pending.request.op as SchedulerOp)); trial.recordMemory(beforeMemory,event.hash,MEMORY_OPS.includes(pending.request.op as MemoryOp)?pending.request.op as MemoryOp:undefined); kernel = trial; }
      consumed.add(requestHash);
      syscalls.push({ requestHash, resultHash: event.hash, caller: event.process, op: pending.request.op,
                      args: { ...pending.request.args }, outcome, position });
      applied.push(event.hash);
      continue;
    }
    if (event.type !== "process-suspend" && event.type !== "process-resume" && event.type !== "process-terminate") continue;
    const start = starts.get(event.process);
    if (!start) { rejected.push({ hash: event.hash, reason: "lifecycle event precedes or lacks process-start" }); continue; }
    const scope = parseQosCapabilityScope(start.payload.scope);
    if (event.source !== start.source || event.capability !== start.capability ||
        event.grant !== "root" || !scope || !scopeAllows(scope, event.type)) {
      rejected.push({ hash: event.hash, reason: "lifecycle event is not root-attributed or lacks scope" });
      continue;
    }
    const transition = event.type === "process-suspend" ? "suspend" : event.type === "process-resume" ? "resume" : "terminate";
    const before = kernel.snapshotLiveHandles();
    const beforeMemory = kernel.memoryRootSnapshot();
    const beforeProcesses = kernel.snapshotProcessState();
    const result = kernel.replayLifecycle(event.process, transition);
    if (!result.ok) rejected.push({ hash: event.hash, reason: result.detail ?? result.errno });
    else { kernel.recordHandleVersions(before, event.hash); kernel.recordProcessVersions(beforeProcesses, event.hash); kernel.recordScheduler(event.hash); kernel.recordMemory(beforeMemory,event.hash); applied.push(event.hash); }
  }
  return { kernel, applied, rejected, missingDependencies: order.missingDependencies, cyclicHashes: order.cyclicHashes, syscalls, pendingSyscalls: [...requests.keys()].filter(hash => !consumed.has(hash)) };
}
