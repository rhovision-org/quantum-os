/** Isolated syscall test trace, not a machine journal or room protocol.
 * qos.event/1 remains the sole canonical journal (#317).
 * The trace is a local falsification instrument for deterministic kernel outcomes. */
import { canonicalJson, sha256Hex } from "./qos-process.js";
import { QosKernel, type QosResult, type QosSignal, type QosProcessInfo, type QosHandleInfo } from "./qos-kernel.js";

export type QosSyscallRequest =
  | { op: "bootstrap"; name: string; owner: string; parent?: string | null; pid?: string }
  | { op: "getpid"; pid: string }
  | { op: "getppid"; pid: string }
  | { op: "spawn"; caller: string; image: string; name: string }
  | { op: "open"; caller: string; object: string; rights: number; parentHandle?: string }
  | { op: "cap_derive"; caller: string; handle: string; rights: number }
  | { op: "cap_close"; caller: string; handle: string }
  | { op: "cap_revoke"; caller: string; handle: string }
  | { op: "signal"; caller: string; target: string; signal: QosSignal }
  | { op: "wait"; caller: string; child: string }
  | { op: "exit"; caller: string; code?: number };
export type QosSyscallValue = string | null | true | number | QosProcessInfo | QosHandleInfo;
export type QosSyscallOutcome = { ok: true; value: QosSyscallValue } | { ok: false; errno: string; detail?: string };
export interface QosSyscallTraceEntry { schema: "qos.test-trace/1"; seq: number; prev: string; request: QosSyscallRequest; outcome: QosSyscallOutcome; stateDigest: string; hash: string }
export interface QosSyscallReplay { kernel: QosKernel; accepted: QosSyscallTraceEntry[]; rejected: { seq: number; reason: string }[]; stateDigest: string }
const GENESIS = "genesis";
const entryBody = (e: Omit<QosSyscallTraceEntry, "hash"> | QosSyscallTraceEntry) => ({ schema: e.schema, seq: e.seq, prev: e.prev, request: e.request, outcome: e.outcome, stateDigest: e.stateDigest });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const snapshot = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
function execute(k: QosKernel, r: QosSyscallRequest): QosResult<any> {
  switch (r.op) {
    case "bootstrap": return k.createProcess({ name: r.name, owner: r.owner, parent: r.parent, pid: r.pid });
    case "getpid": return k.getpid(r.pid);
    case "getppid": return k.getppid(r.pid);
    case "spawn": return k.spawn(r.caller, r.image, r.name);
    case "open": return k.open(r.caller, r.object, r.rights, r.parentHandle);
    case "cap_derive": return k.capDerive(r.caller, r.handle, r.rights);
    case "cap_close": return k.capClose(r.caller, r.handle);
    case "cap_revoke": return k.capRevoke(r.caller, r.handle);
    case "signal": return k.signal(r.caller, r.target, r.signal);
    case "wait": return k.wait(r.caller, r.child);
    case "exit": return k.exit(r.caller, r.code);
    default: throw new Error("unsupported trace operation");
  }
}
function normalize(result: QosResult<any>): QosSyscallOutcome {
  return result.ok ? { ok: true, value: result.value } : { ok: false, errno: result.errno, ...(result.detail ? { detail: result.detail } : {}) };
}
export class QosSyscallTrace {
  private entries: QosSyscallTraceEntry[] = [];
  private tail = GENESIS;
  private kernel = new QosKernel();
  private pending: Promise<void> = Promise.resolve();
  list(): QosSyscallTraceEntry[] { return snapshot(this.entries); }
  async invoke(request: QosSyscallRequest): Promise<QosSyscallOutcome> {
    const stableRequest = snapshot(request);
    const run = this.pending.then(async () => {
      const trial = this.kernel.cloneForReplay();
      const outcome = snapshot(normalize(execute(trial, stableRequest)));
      const stateDigest = await trial.stateDigest();
      const body: Omit<QosSyscallTraceEntry, "hash"> = { schema: "qos.test-trace/1", seq: this.entries.length + 1, prev: this.tail, request: stableRequest, outcome, stateDigest };
      const hash = await sha256Hex(canonicalJson(entryBody(body)));
      const entry: QosSyscallTraceEntry = { ...body, hash };
      this.entries.push(snapshot(entry));
      this.tail = hash;
      this.kernel = trial;
      return snapshot(outcome);
    });
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }
  async digest(): Promise<string> {
    await this.pending;
    return this.kernel.stateDigest();
  }
  static async replay(entries: QosSyscallTraceEntry[]): Promise<QosSyscallReplay> {
    const stableEntries = snapshot(entries);
    let kernel = new QosKernel(); const accepted: QosSyscallTraceEntry[] = []; const rejected: { seq: number; reason: string }[] = [];
    let tail = GENESIS;
    for (const entry of stableEntries) {
      const reject = (reason: string) => { rejected.push({ seq: entry?.seq ?? -1, reason }); };
      if (!entry || entry.schema !== "qos.test-trace/1") { reject("unsupported schema"); break; }
      if (entry.seq !== accepted.length + 1) { reject("non-contiguous sequence"); break; }
      if (entry.prev !== tail) { reject("previous hash mismatch"); break; }
      const hash = await sha256Hex(canonicalJson(entryBody(entry)));
      if (hash !== entry.hash) { reject("entry hash mismatch"); break; }
      const trial = kernel.cloneForReplay();
      let actual: QosSyscallOutcome;
      try { actual = normalize(execute(trial, entry.request)); } catch (e) { reject(`execution error: ${String(e)}`); break; }
      if (!same(actual, entry.outcome)) { reject("recorded outcome differs from execution"); break; }
      const stateDigest = await trial.stateDigest();
      if (stateDigest !== entry.stateDigest) { reject("kernel state digest mismatch"); break; }
      kernel = trial;
      accepted.push(entry); tail = entry.hash;
    }
    return { kernel, accepted, rejected, stateDigest: await kernel.stateDigest() };
  }
}
