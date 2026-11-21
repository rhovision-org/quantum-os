/// QOS process orchestration over a QuantumOS room — PR gate quantum-os#264.
///
/// The gate's claim is that the room primitives are enough for long-lived,
/// named processes: a process is a capability-guarded continuation over the
/// room's ZFA process space, every lifecycle step is a dyncap-attributed event, and any
/// peer can recompute the orchestration result from the same envelopes.
///
/// This module is deliberately **pure and transport-free**:
///
///   - the event schema is a finite, explicit JSON shape (`QosEvent`);
///   - `QosEventLog` is the verification boundary (dyncap chain, hash chain,
///     payload hash, ZFA balance, capability attenuation);
///   - `orchestrate` is the deterministic reducer (the example composition:
///     nominations -> ranked poll -> lemma-of-record -> optional anchor);
///   - `QosProcessRoom` is the thin `QOSPeer` adapter that signs, broadcasts,
///     and ingests the same events a room or a rholo/rholalc consumer reads.
///
/// It adds no chain RPC, no clock, no trusted coordinator, and no new project
/// axiom. The optional anchor is an event carrying an already-produced deploy
/// reference; the reducer never calls a node.
///
/// ZFA and capability facts are delegated to the existing `zfa.ts` predicates
/// (`achievesZfa`, `validateCapability`) and to `dyncap.ts` (`signEnvelope`,
/// `verifyEnvelope`). See `docs/qos-process.md` for the contract and the gate
/// mapping.

import {
  nextSeqFor,
  signEnvelope,
  verifyEnvelope,
  type ChainEntry,
  type DyncapField,
  type DynCapState,
} from "./dyncap.js";
import { optionId, tallyRanked, type Poll, type PollOption, type RankedResult } from "./polls.js";
import { achievesZfa, validateCapability } from "./zfa.js";

/// Re-exported so a consumer that names an option can compute the same content
/// id the reducer uses, without importing the poll module separately.
export { optionId };

/// The only event schema this module emits or accepts. A different schema is a
/// different protocol: `parseQosEvent` rejects it instead of guessing fields.
export const QOS_EVENT_SCHEMA = "qos.event/1";

/// The finite event vocabulary. There is no open-ended `kind` payload: every
/// transition the gate names has a type here. The #317 extension requires coordinated client support; older decoders reject new types.
export const QOS_EVENT_TYPES = [
  "process-start",
  "process-suspend",
  "process-resume",
  "process-terminate",
  "capability-grant",
  "nomination",
  "poll-open",
  "ballot",
  "poll-close",
  "lemma",
  "anchor",
  "syscall-request",
  "syscall-result",
] as const;

export type QosEventType = (typeof QOS_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(QOS_EVENT_TYPES);
const LIFECYCLE_TYPES: ReadonlySet<QosEventType> = new Set([
  "process-start",
  "process-suspend",
  "process-resume",
  "process-terminate",
]);

/// A capability is a ZFA token plus a scope. The token is the authority; the
/// scope is what the holder may use it for. A child grant may only narrow this.
export interface QosCapabilityScope {
  process: string;
  events: QosEventType[];
  canLifecycle: boolean;
  canGrant: boolean;
  canClose: boolean;
  canAnchor: boolean;
}

/// The explicit event shape the gate asks for: source, capability, payload
/// hash, sequence — plus the process identity and the hash/dyncap chain links
/// that make ordering and tamper evidence local facts.
export interface QosEvent {
  kind: "qos-event";
  schema: typeof QOS_EVENT_SCHEMA;
  type: QosEventType;
  process: string;
  /// Stable dyncap anchor of the emitter. This is the source the capability
  /// grant is bound to; a transport peer id is never trusted as identity.
  source: string;
  /// ZFA capability token presented for this event.
  capability: string;
  /// "root" for the process-start event and root-capability operations, or
  /// the hash of the capability-grant event that issued `capability`.
  grant: string;
  /// Per-source sequence, equal to `dyncap.seq`. Monotonic per room.
  seq: number;
  /// Previous event hash from this source *within this process*, or "genesis".
  prev: string;
  payload: Record<string, unknown>;
  /// SHA-256 of the canonical payload.
  payloadHash: string;
  /// A small ZFA-balanced action history derived from `payloadHash`. Every
  /// event carries one, so composing a process's events preserves ZFA.
  zfa: number[];
  /// SHA-256 of the canonical event without `hash` and `dyncap`.
  hash: string;
  dyncap: DyncapField;
}

const EVENT_FIELDS: ReadonlySet<string> = new Set([
  "kind", "schema", "type", "process", "source", "capability", "grant",
  "seq", "prev", "payload", "payloadHash", "zfa", "hash", "dyncap",
]);
const DYNACAP_FIELDS: ReadonlySet<string> = new Set(["anchor", "seq", "witness"]);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_ANY = /^[0-9a-f]+$/i;

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

/// Deterministic JSON: object keys sorted recursively, array order preserved.
/// Both a room peer and a rholo/rholalc consumer hash the same bytes from the
/// same event, so a payload hash is not serializer-dependent.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

async function payloadHashOf(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

function eventWithoutChainFields(event: QosEvent | Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  delete copy.hash;
  delete copy.dyncap;
  return copy;
}

async function eventHashOf(event: QosEvent | Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(eventWithoutChainFields(event)));
}

/// Four conjugate twist pairs (`^v`, `> <`, `/\`, `+-`). Choosing one pair per
/// hash nibble keeps every event's action history count-balanced and Pauli
/// scalar; concatenating those histories is therefore still ZFA.
const CONJUGATE_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1], // Up, Down
  [2, 3], // Right, Left
  [4, 5], // Slash, BSlash
  [6, 7], // Plus, Minus
];

function zfaForHash(hash: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const nibble = parseInt(hash[i] ?? "0", 16);
    const pair = CONJUGATE_PAIRS[nibble & 3];
    out.push(pair[0], pair[1]);
  }
  return out;
}

/// The action history of a process: the concatenation of its events' small
/// ZFA histories, in canonical event order. Used by the invariant checks.
export function concatZfa(events: QosEvent[]): number[] {
  return canonicalEvents(events).flatMap((e) => e.zfa);
}

export function zfaHistoryAchievesZfa(events: QosEvent[]): boolean {
  const history = concatZfa(events);
  return history.length === 0 || achievesZfa(Uint8Array.from(history));
}

// ---------------------------------------------------------------------------
// Capability derivation and attenuation
// ---------------------------------------------------------------------------

function capabilityParts(token: string): { label: string; hex: string } | null {
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== "cap" || parts[1].length === 0) return null;
  if (!/^[0-7]+$/.test(parts[2])) return null;
  return { label: parts[1], hex: parts[2] };
}

function randomHex(bytes = 16): string {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  let text = "";
  for (const b of out) text += b.toString(16).padStart(2, "0");
  return text;
}

/// Derive a child ZFA capability by appending conjugate pairs to the parent
/// token. The child's twist string starts with the parent's, which is the
/// structural attenuation check `isCapabilityAttenuated` uses. Appending
/// `[pos, neg]` pairs keeps the token count-balanced and Pauli scalar, so the
/// child is ZFA whenever the parent is.
export function deriveProcessCapability(parentToken: string, entropyHex?: string): string {
  const parent = capabilityParts(parentToken);
  if (!parent || !validateCapability(parentToken)) {
    throw new Error("deriveProcessCapability: parent is not a valid ZFA capability");
  }
  const entropy = entropyHex ?? randomHex(16);
  if (!HEX_ANY.test(entropy)) {
    throw new Error("deriveProcessCapability: entropy must be hex");
  }
  let suffix = "";
  for (const ch of entropy.toLowerCase()) {
    const pair = CONJUGATE_PAIRS[parseInt(ch, 16) & 3];
    suffix += `${pair[0]}${pair[1]}`;
  }
  const child = `cap:process:${parent.hex}${suffix}`;
  if (!validateCapability(child)) {
    throw new Error("deriveProcessCapability: derived child is not a valid ZFA capability");
  }
  return child;
}

/// True iff `child` is a strict structural extension of `parent` — the
/// capability half of attenuation. The scope half is `attenuateScope`.
export function isCapabilityAttenuated(parentToken: string, childToken: string): boolean {
  if (!validateCapability(parentToken) || !validateCapability(childToken)) return false;
  const parent = capabilityParts(parentToken);
  const child = capabilityParts(childToken);
  if (!parent || !child) return false;
  return child.label === "process" && child.hex.length > parent.hex.length && child.hex.startsWith(parent.hex);
}

export function newRootScope(process: string): QosCapabilityScope {
  return {
    process,
    events: ["nomination", "ballot", "syscall-request", "syscall-result"],
    canLifecycle: true,
    canGrant: true,
    canClose: true,
    canAnchor: true,
  };
}

export function newParticipantScope(
  process: string,
  events: QosEventType[] = ["nomination", "ballot"],
): QosCapabilityScope {
  return {
    process,
    events: [...new Set(events)].sort(compareStrings),
    canLifecycle: false,
    canGrant: false,
    canClose: false,
    canAnchor: false,
  };
}

export function parseQosCapabilityScope(value: unknown): QosCapabilityScope | null {
  if (!isRecord(value)) return null;
  if (typeof value.process !== "string" || value.process.length === 0) return null;
  if (!Array.isArray(value.events)) return null;
  const events: QosEventType[] = [];
  for (const event of value.events) {
    if (typeof event !== "string" || !EVENT_TYPE_SET.has(event)) return null;
    events.push(event as QosEventType);
  }
  for (const flag of ["canLifecycle", "canGrant", "canClose", "canAnchor"] as const) {
    if (typeof value[flag] !== "boolean") return null;
  }
  return {
    process: value.process,
    events: [...new Set(events)].sort(compareStrings),
    canLifecycle: value.canLifecycle as boolean,
    canGrant: value.canGrant as boolean,
    canClose: value.canClose as boolean,
    canAnchor: value.canAnchor as boolean,
  };
}

/// Narrowing only: a child may drop event types and rights, never add them.
/// Returns the normalized child scope, or null when the grant would broaden.
export function attenuateScope(
  parent: QosCapabilityScope,
  child: QosCapabilityScope,
): QosCapabilityScope | null {
  if (child.process !== parent.process) return null;
  const parentEvents = new Set(parent.events);
  if (!child.events.every((event) => parentEvents.has(event))) return null;
  if (child.canLifecycle && !parent.canLifecycle) return null;
  if (child.canGrant && !parent.canGrant) return null;
  if (child.canClose && !parent.canClose) return null;
  if (child.canAnchor && !parent.canAnchor) return null;
  return {
    ...child,
    events: [...new Set(child.events)].sort(compareStrings),
  };
}

export function scopeAllows(scope: QosCapabilityScope, type: QosEventType): boolean {
  if (LIFECYCLE_TYPES.has(type)) return scope.canLifecycle;
  if (type === "capability-grant") return scope.canGrant;
  if (type === "poll-open" || type === "poll-close" || type === "lemma") return scope.canClose;
  if (type === "anchor") return scope.canAnchor;
  return scope.events.includes(type);
}

// ---------------------------------------------------------------------------
// Event shape validation (strict; no silent translation)
// ---------------------------------------------------------------------------

export interface EventShapeResult {
  ok: boolean;
  event?: QosEvent;
  reason?: string;
}

/// Structural validation only. Hash and dyncap verification are asynchronous
/// and live in `QosEventLog.ingest`; this is what a rholalc consumer can run
/// synchronously before it touches the event.
export function validateQosEventShape(input: unknown): EventShapeResult {
  if (!isRecord(input)) return { ok: false, reason: "event is not an object" };
  for (const key of Object.keys(input)) {
    if (!EVENT_FIELDS.has(key)) return { ok: false, reason: `unknown field ${key}` };
  }
  if (input.kind !== "qos-event") return { ok: false, reason: "kind is not qos-event" };
  if (input.schema !== QOS_EVENT_SCHEMA) return { ok: false, reason: `schema is not ${QOS_EVENT_SCHEMA}` };
  if (typeof input.type !== "string" || !EVENT_TYPE_SET.has(input.type)) {
    return { ok: false, reason: "unknown event type" };
  }
  for (const field of ["process", "source", "capability", "grant", "prev"] as const) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      return { ok: false, reason: `${field} must be a non-empty string` };
    }
  }
  if (!validateCapability(input.capability as string)) {
    return { ok: false, reason: "capability is not a valid ZFA token" };
  }
  if (!Number.isInteger(input.seq) || (input.seq as number) < 1) {
    return { ok: false, reason: "seq must be a positive integer" };
  }
  if (!isRecord(input.payload)) return { ok: false, reason: "payload must be an object" };
  for (const field of ["payloadHash", "hash"] as const) {
    if (typeof input[field] !== "string" || !HEX64.test(input[field])) {
      return { ok: false, reason: `${field} must be 64 lowercase hex` };
    }
  }
  if (!Array.isArray(input.zfa) || input.zfa.length < 2 || input.zfa.length % 2 !== 0) {
    return { ok: false, reason: "zfa must be an even-length array" };
  }
  for (const twist of input.zfa) {
    if (!Number.isInteger(twist) || twist < 0 || twist > 7) {
      return { ok: false, reason: "zfa twists must be integers 0..7" };
    }
  }
  if (!achievesZfa(Uint8Array.from(input.zfa as number[]))) {
    return { ok: false, reason: "event zfa history does not achieve ZFA" };
  }
  if (!isRecord(input.dyncap)) return { ok: false, reason: "dyncap must be an object" };
  for (const key of Object.keys(input.dyncap)) {
    if (!DYNACAP_FIELDS.has(key)) return { ok: false, reason: `unknown dyncap field ${key}` };
  }
  if (typeof input.dyncap.anchor !== "string" || !HEX64.test(input.dyncap.anchor)) {
    return { ok: false, reason: "dyncap.anchor must be 64 lowercase hex" };
  }
  if (typeof input.dyncap.witness !== "string" || !HEX64.test(input.dyncap.witness)) {
    return { ok: false, reason: "dyncap.witness must be 64 lowercase hex" };
  }
  if (!Number.isInteger(input.dyncap.seq) || (input.dyncap.seq as number) < 1) {
    return { ok: false, reason: "dyncap.seq must be a positive integer" };
  }
  return { ok: true, event: input as unknown as QosEvent };
}

export function parseQosEvent(input: unknown): QosEvent | null {
  const result = validateQosEventShape(input);
  return result.ok ? result.event! : null;
}

export function decodeQosEvent(json: string): QosEvent | null {
  try {
    return parseQosEvent(JSON.parse(json));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signing and the local event log
// ---------------------------------------------------------------------------

/// Signs events for one identity in one room. It tracks the previous hash per
/// `(process, source)` so the hash chain is source-local and independent of
/// arrival order: a peer that receives the whole set can verify every link.
export class QosEventSigner {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly lastByProcess = new Map<string, string>();

  constructor(
    readonly identity: DynCapState,
    readonly roomId: string,
    /// Optional: recover the last event hash after a reload, when this signer's
    /// in-memory map is empty but the process log is not.
    private readonly prevFor?: (process: string, source: string) => string | undefined,
  ) {}

  async sign(
    process: string,
    capability: string,
    grant: string,
    type: QosEventType,
    payload: Record<string, unknown>,
  ): Promise<QosEvent> {
    const snapshot = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const result = this.pending.then(() => this.signOne(process, capability, grant, type, snapshot));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async signOne(
    process: string, capability: string, grant: string, type: QosEventType,
    payload: Record<string, unknown>,
  ): Promise<QosEvent> {
    if (!validateCapability(capability)) throw new Error("sign: capability is not a valid ZFA token");
    const payloadHash = await payloadHashOf(payload);
    const zfa = zfaForHash(payloadHash);
    const seq = nextSeqFor(this.identity, this.roomId);
    const key = `${process}\u0000${this.identity.anchor}`;
    const prev = this.lastByProcess.get(key)
      ?? this.prevFor?.(process, this.identity.anchor)
      ?? "genesis";
    const base: Record<string, unknown> = {
      kind: "qos-event",
      schema: QOS_EVENT_SCHEMA,
      type,
      process,
      source: this.identity.anchor,
      capability,
      grant,
      seq,
      prev,
      payload,
      payloadHash,
      zfa,
    };
    const hash = await eventHashOf(base);
    const event = { ...base, hash } as unknown as QosEvent;
    event.dyncap = await signEnvelope(this.identity, this.roomId, event as unknown as Record<string, unknown>);
    this.lastByProcess.set(key, hash);
    return event;
  }
}

export interface IngestResult {
  ok: boolean;
  duplicate?: boolean;
  fork?: boolean;
  reason?: string;
}

/// The verification boundary. An event enters the log only if:
///
///   1. its shape is the finite schema above;
///   2. `source` is the dyncap anchor it claims and `seq` is the dyncap seq;
///   3. its payload hash and event hash recompute;
///   4. its action history achieves ZFA;
///   5. its dyncap chain extends the prior chain (TOFU, monotonic, no fork);
///   6. its `(source, seq)` is not already occupied by a different event.
///
/// A source that forks is quarantined: nothing it sent is used by the reducer.
/// That is deliberately blunt and deterministic — no peer has to decide which
/// branch is "real".
export class QosEventLog {
  private readonly eventsByHash = new Map<string, QosEvent>();
  private readonly hashBySourceSeq = new Map<string, string>();
  private readonly chains = new Map<string, ChainEntry>();
  private readonly rejected: { hash: string; type: string; reason: string }[] = [];
  private readonly quarantined = new Set<string>();
  private readonly forkEvidence = new Map<string, QosEvent>();
  private pending: Promise<unknown> = Promise.resolve();

  get forkedSources(): ReadonlySet<string> { return new Set(this.quarantined); }

  constructor(readonly roomId: string) {}

  async ingest(event: QosEvent): Promise<IngestResult> {
    // Capture the wire value before yielding; never retain caller-owned data.
    let snapshot: QosEvent;
    try { snapshot = JSON.parse(JSON.stringify(event)) as QosEvent; }
    catch { return this.reject(event, "event is not JSON serializable"); }
    const result = this.pending.then(() => this.ingestOne(snapshot));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ingestOne(event: QosEvent): Promise<IngestResult> {
    const shape = validateQosEventShape(event);
    if (!shape.ok) return this.reject(event, shape.reason ?? "invalid shape");

    if (event.source !== event.dyncap.anchor) return this.reject(event, "source does not match dyncap anchor");
    if (event.seq !== event.dyncap.seq) return this.reject(event, "seq does not match dyncap seq");

    const payloadHash = await payloadHashOf(event.payload);
    if (payloadHash !== event.payloadHash) return this.reject(event, "payload hash does not recompute");

    const hash = await eventHashOf(event);
    if (hash !== event.hash) return this.reject(event, "event hash does not recompute");

    if (!achievesZfa(Uint8Array.from(event.zfa))) return this.reject(event, "event zfa history does not achieve ZFA");

    const sourceSeq = `${event.source}\u0000${event.seq}`;
    const existing = this.hashBySourceSeq.get(sourceSeq);
    if (existing !== undefined) {
      const accepted = this.eventsByHash.get(existing)!;
      if (existing === event.hash && accepted.dyncap.witness === event.dyncap.witness)
        return { ok: true, duplicate: true };
      this.quarantined.add(event.source);
      this.forkEvidence.set(event.hash + ":" + event.dyncap.witness, event);
      return { ok: false, fork: true, reason: "source+seq already carries a different event or witness" };
    }

    // Dyncap is a set of (seq, witness) links, not an ordered stream: an event
    // that arrives before its predecessors is still a valid chain member. The
    // per-process `prev` links are checked as a set by `brokenChainsIn`, so
    // reordering delivery never changes the result.
    const prior = this.chains.get(event.source);

    const verified = await verifyEnvelope(prior, this.roomId, event as unknown as Record<string, unknown>, event.dyncap);
    if (verified.kind === "invalid") return this.reject(event, verified.reason);
    if (verified.kind === "anchor-mismatch") {
      this.quarantined.add(event.source);
      return { ok: false, fork: true, reason: "anchor mismatch" };
    }
    if (verified.kind === "fork") {
      this.quarantined.add(event.source);
      return { ok: false, fork: true, reason: `fork at seq ${verified.seq}` };
    }
    if (verified.kind === "replay") {
      return this.reject(event, `replay at seq ${verified.seq}`);
    }

    this.chains.set(event.source, verified.entry);
    this.eventsByHash.set(event.hash, event);
    this.hashBySourceSeq.set(sourceSeq, event.hash);
    return { ok: true };
  }

  private reject(event: unknown, reason: string): IngestResult {
    const record = isRecord(event) ? event : {};
    const hash = typeof record.hash === "string" ? record.hash : "?";
    const type = typeof record.type === "string" ? record.type : "?";
    this.rejected.push({ hash, type, reason });
    return { ok: false, reason };
  }

  has(hash: string): boolean {
    return this.eventsByHash.has(hash);
  }

  /// Accepted events in canonical order. Events from a forked source remain
  /// out: `forkedSources` is the quarantine list.
  events(): QosEvent[] {
    const accepted = [...this.eventsByHash.values()]
      .filter((event) => !this.quarantined.has(event.source));
    // The journal's public view is causal, not merely tuple-sorted. Consumers
    // that need diagnostics must call canonicalEventOrder explicitly; this view
    // remains total and deterministic for partial/offline logs.
    return JSON.parse(JSON.stringify(canonicalEventOrder(accepted).ordered)) as QosEvent[];
  }

  eventsFor(process: string): QosEvent[] {
    return this.events().filter((event) => event.process === process);
  }

  rejectedEvents(): { hash: string; type: string; reason: string }[] {
    return [...this.rejected].sort((a, b) => compareStrings(a.hash, b.hash));
  }

  async mergeFrom(other: QosEventLog): Promise<IngestResult[]> {
    const out: IngestResult[] = [];
    if (other.roomId !== this.roomId) throw new Error("cannot merge a different room");
    // Relay both verified-envelope branches, not an unauthenticated quarantine flag.
    // The receiver independently detects the conflict under the same TOFU model.
    const evidence = [...other.eventsByHash.values(), ...other.forkEvidence.values()];
    for (const event of evidence.sort(compareEvents)) out.push(await this.ingest(event));
    return out;
  }
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEvents(a: QosEvent, b: QosEvent): number {
  return compareStrings(a.source, b.source) ||
    (a.seq - b.seq) ||
    compareStrings(a.hash, b.hash);
}

export type QosDependencyKind = "prev" | "grant" | "request" | "handle-version";
export interface QosDependency { hash: string; kind: QosDependencyKind }
/** Only schema-defined references are causal, never arbitrary payload strings. */
export function eventDependencies(event: QosEvent): QosDependency[] {
  const refs: QosDependency[] = [];
  if (event.prev !== "genesis") refs.push({ hash: event.prev, kind: "prev" });
  if (event.grant !== "root") refs.push({ hash: event.grant, kind: "grant" });
  if (event.type === "syscall-result" && event.payload?.schema === "qos.syscall/1" &&
      typeof event.payload.requestHash === "string" && HEX64.test(event.payload.requestHash)) {
    refs.push({ hash: event.payload.requestHash, kind: "request" });
  }
  if (event.type === "syscall-request" && event.payload?.schema === "qos.syscall/1" &&
      typeof event.payload.op === "string" && ["cap_derive", "cap_close", "cap_revoke"].includes(event.payload.op) &&
      isRecord(event.payload.args) && typeof event.payload.args.handleVersion === "string" &&
      HEX64.test(event.payload.args.handleVersion)) {
    refs.push({ hash: event.payload.args.handleVersion, kind: "handle-version" });
  }
  return refs;
}

/**
 * Causal canonicalization. `prev`, non-root `grant`, request and handle-version are explicit hash
 * dependencies. They are topologically ordered before stable tie-breaking; the
 * `(source, seq, hash)` tuple is used only among currently-ready events.
 * Missing references and cycles are returned as deterministic diagnostics rather
 * than silently being treated as causal edges. Other object kinds need their own schema-defined references.
 */
export function canonicalEventOrder(events: QosEvent[]): {
  ordered: QosEvent[];
  missingDependencies: { eventHash: string; dependencyHash: string; kind: QosDependencyKind }[];
  cyclicHashes: string[];
} {
  const unique = new Map<string, QosEvent>();
  for (const event of events) if (!unique.has(event.hash)) unique.set(event.hash, event);
  const nodes = [...unique.values()];
  const byHash = unique;
  const deps = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const missingDependencies: { eventHash: string; dependencyHash: string; kind: QosDependencyKind }[] = [];
  for (const event of nodes) {
    const required = new Set<string>();
    const refs = eventDependencies(event);
    for (const ref of refs) {
      if (!byHash.has(ref.hash)) {
        missingDependencies.push({ eventHash: event.hash, dependencyHash: ref.hash, kind: ref.kind });
        continue;
      }
      if (ref.hash === event.hash) { required.add(ref.hash); continue; }
      required.add(ref.hash);
      const childSet = children.get(ref.hash) ?? new Set<string>();
      childSet.add(event.hash);
      children.set(ref.hash, childSet);
    }
    deps.set(event.hash, required);
  }
  missingDependencies.sort((a, b) => compareEvents(byHash.get(a.eventHash)!, byHash.get(b.eventHash)!) || compareStrings(a.kind, b.kind) || compareStrings(a.dependencyHash, b.dependencyHash));
  const ready = nodes.filter((e) => (deps.get(e.hash)?.size ?? 0) === 0).sort(compareEvents);
  const ordered: QosEvent[] = [];
  const emitted = new Set<string>();
  while (ready.length) {
    const event = ready.shift()!;
    if (emitted.has(event.hash)) continue;
    emitted.add(event.hash);
    ordered.push(event);
    for (const childHash of children.get(event.hash) ?? []) {
      const childDeps = deps.get(childHash);
      childDeps?.delete(event.hash);
      if (childDeps && childDeps.size === 0) {
        const child = byHash.get(childHash)!;
        ready.push(child);
        ready.sort(compareEvents);
      }
    }
  }
  const cyclicHashes = nodes.filter((event) => !emitted.has(event.hash)).map((event) => event.hash).sort(compareStrings);
  // Keep the result total and deterministic for diagnostic consumers. Cyclic nodes
  // are appended in stable order, but the returned cycle list marks the order
  // as invalid; callers must not interpret it as a valid causal replay.
  ordered.push(...nodes.filter((event) => !emitted.has(event.hash)).sort(compareEvents));
  return { ordered, missingDependencies, cyclicHashes };
}


/// Canonical order is causal first, stable tuple order among ready events.
/// This convenience view is total; use canonicalEventOrder diagnostics to detect
/// incomplete or cyclic dependency graphs before accepting a replay.
export function canonicalEvents(events: QosEvent[]): QosEvent[] {
  return canonicalEventOrder(events).ordered;
}

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

interface ResolvedCapability {
  scope: QosCapabilityScope;
  boundTo: string;
  grantHash: string;
  depth: number;
}

type ResolveResult =
  | { ok: true; cap: ResolvedCapability }
  | { ok: false; reason: string };

function resolveCapability(
  byHash: Map<string, QosEvent>,
  start: QosEvent,
  event: QosEvent,
  depth = 0,
  seen = new Set<string>(),
): ResolveResult {
  if (depth > 64) return { ok: false, reason: "capability grant chain too deep" };
  if (seen.has(event.hash)) return { ok: false, reason: "capability grant cycle" };
  seen.add(event.hash);
  if (!validateCapability(event.capability)) {
    return { ok: false, reason: "capability is not a valid ZFA token" };
  }

  if (event.type === "process-start") {
    if (event.hash !== start.hash) return { ok: false, reason: "a process has more than one start event" };
    if (event.capability !== start.payload.rootCapability) {
      return { ok: false, reason: "process-start capability is not the declared root capability" };
    }
    const scope = parseQosCapabilityScope(start.payload.scope);
    if (!scope || scope.process !== start.process) {
      return { ok: false, reason: "process-start scope does not name this process" };
    }
    return { ok: true, cap: { scope, boundTo: start.source, grantHash: start.hash, depth: 0 } };
  }

  // Root-capability operations (lifecycle, close, lemma, anchor, and the root
  // holder's own nominations/ballots) need no grant event: the process-start
  // event is the grant, and it is bound to the start source.
  if (event.grant === "root") {
    if (event.capability !== start.payload.rootCapability) {
      return { ok: false, reason: "root-granted event does not carry the root capability" };
    }
    const scope = parseQosCapabilityScope(start.payload.scope);
    if (!scope || scope.process !== start.process) {
      return { ok: false, reason: "process-start scope does not name this process" };
    }
    if (event.source !== start.source) return { ok: false, reason: "root capability is bound to a different source" };
    if (!scopeAllows(scope, event.type)) {
      return { ok: false, reason: `capability does not allow ${event.type}` };
    }
    return { ok: true, cap: { scope, boundTo: start.source, grantHash: start.hash, depth: 0 } };
  }

  const grantEvent = byHash.get(event.grant);
  if (!grantEvent) return { ok: false, reason: "capability grant event is missing" };
  if (grantEvent.type !== "capability-grant") {
    return { ok: false, reason: "grant does not name a capability-grant event" };
  }
  if (grantEvent.process !== start.process) {
    return { ok: false, reason: "grant belongs to a different process" };
  }

  // The grant event must itself be authorized by the parent capability. That
  // recursive resolution also checks the parent scope's `canGrant` right.
  const authority = resolveCapability(byHash, start, grantEvent, depth + 1, seen);
  if (!authority.ok) return authority;

  const to = grantEvent.payload.to;
  const childCapability = grantEvent.payload.childCapability;
  const childScope = parseQosCapabilityScope(grantEvent.payload.childScope);
  if (typeof to !== "string" || to.length === 0) return { ok: false, reason: "grant target is missing" };
  if (typeof childCapability !== "string" || childCapability !== event.capability) {
    return { ok: false, reason: "grant child capability does not match the event capability" };
  }
  if (!childScope || childScope.process !== start.process) {
    return { ok: false, reason: "grant scope does not name this process" };
  }
  if (!isCapabilityAttenuated(grantEvent.capability, childCapability)) {
    return { ok: false, reason: "granted capability is not an attenuated child" };
  }
  const narrowed = attenuateScope(authority.cap.scope, childScope);
  if (!narrowed) return { ok: false, reason: "grant broadens the parent scope" };
  if (event.source !== to) return { ok: false, reason: "capability is bound to a different source" };
  if (!scopeAllows(narrowed, event.type)) {
    return { ok: false, reason: `capability does not allow ${event.type}` };
  }
  return {
    ok: true,
    cap: { scope: narrowed, boundTo: to, grantHash: grantEvent.hash, depth: authority.cap.depth + 1 },
  };
}

// ---------------------------------------------------------------------------
// Deterministic orchestration reducer
// ---------------------------------------------------------------------------

export interface QosQuorum {
  required: number;
  sources: string[] | null;
}

export interface QosProcessView {
  process: string;
  name: string;
  question: string;
  status: "unstarted" | "running" | "suspended" | "terminated" | "conflicted";
  phase: "unstarted" | "nominations" | "polling" | "tally" | "recorded" | "anchored" | "conflicted";
  blocked: string | null;
  quorum: { required: number; sources: string[] | null; met: boolean; missing: string[] };
  participatingSources: string[];
  nominations: { id: string; text: string; by: string[] }[];
  poll: {
    question: string;
    method: string;
    optionIds: string[];
    ballotCount: number;
    ballots: Record<string, string[]>;
  } | null;
  result: RankedResult | null;
  winnerIds: string[];
  winnerTexts: string[];
  recordHash: string | null;
  finalDigest: string | null;
  stateDigest: string;
  lemma: { name: string; text: string; by: string; recordHash: string } | null;
  anchor: { chain: string; deployId: string; blockHash?: string; recordHash: string; by: string } | null;
  chainMode: "none" | "anchor-event";
  rejected: { hash: string; type: string; reason: string }[];
  conflictedSources: string[];
  invalidTransitions: { hash: string; reason: string }[];
  /// Per-process source chains that are missing a link (offline peer, refused
  /// relay, or a hole in what this peer was given). Reported, never invented.
  brokenChains: { process: string; source: string; reason: string }[];
  eventCount: number;
}

/// Check the per-`(process, source)` `prev` hash chain as a set. Delivery order
/// is irrelevant: events are sorted by seq, and each `prev` must name the
/// previous event's hash (or "genesis" for the first). A missing relayed event
/// shows up as a broken link instead of being silently skipped.
export function brokenChainsIn(events: QosEvent[]): { process: string; source: string; reason: string }[] {
  const groups = new Map<string, QosEvent[]>();
  for (const event of events) {
    const key = `${event.process}\u0000${event.source}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  const out: { process: string; source: string; reason: string }[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => (a.seq - b.seq) || compareStrings(a.hash, b.hash));
    let expected = "genesis";
    for (const event of sorted) {
      if (event.prev !== expected) {
        out.push({
          process: event.process,
          source: event.source,
          reason: `expected prev ${expected.slice(0, 12)}, got ${event.prev.slice(0, 12)} at seq ${event.seq}`,
        });
        break;
      }
      expected = event.hash;
    }
  }
  return out.sort((a, b) =>
    compareStrings(a.process, b.process) ||
    compareStrings(a.source, b.source) ||
    compareStrings(a.reason, b.reason));
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return null;
    out.push(item);
  }
  return out;
}

function parseQuorum(value: unknown): QosQuorum {
  if (!isRecord(value)) return { required: 1, sources: null };
  const required = Math.max(1, intOr(value.required, 1));
  const sources = stringArray(value.sources);
  return { required, sources };
}

interface AnchoredRecord {
  process: string;
  question: string;
  options: { id: string; text: string }[];
  ballots: [string, string[]][];
  result: RankedResult;
}

function outcomeText(view: Pick<QosProcessView, "winnerTexts" | "result">): string {
  if (!view.result || view.result.winners.length === 0) return "no winner (no ballots)";
  if (view.winnerTexts.length === 1) return `winner: ${view.winnerTexts[0]}`;
  return `tie: ${view.winnerTexts.join(", ")}`;
}

/// Reduce a verified event set to a process view. The function is pure and
/// deterministic with respect to the set of events: delivery order, relay path,
/// and which peer runs it do not change `stateDigest` or `finalDigest`.
///
/// Expected to receive events that passed `QosEventLog.ingest`; if called with
/// raw events it still validates capability grants and payload shapes, but it
/// cannot make the dyncap/hash guarantees the log makes.
export async function orchestrate(
  events: QosEvent[],
  opts: { forkedSources?: Iterable<string>; process?: string } = {},
): Promise<QosProcessView> {
  const scoped = opts.process ? events.filter((event) => event.process === opts.process) : events;
  const unique = new Map<string, QosEvent>();
  for (const event of canonicalEvents(scoped)) {
    if (!unique.has(event.hash)) unique.set(event.hash, event);
  }
  const all = canonicalEvents([...unique.values()]);
  const forked = new Set(opts.forkedSources ?? []);
  const conflictedSources = [...forked].sort(compareStrings);
  const rejected: { hash: string; type: string; reason: string }[] = [];
  const finish = (view: Omit<QosProcessView, "stateDigest" | "brokenChains">) => finishView(view, all);
  const causalOrder = canonicalEventOrder(scoped);
  if (causalOrder.cyclicHashes.length > 0) {
    const cyclic = new Set(causalOrder.cyclicHashes);
    const sources = all.filter((event) => cyclic.has(event.hash)).map((event) => event.source);
    return finish({
      process: "", name: "", question: "", status: "conflicted", phase: "conflicted",
      blocked: "causal-dependency-cycle", quorum: { required: 1, sources: null, met: false, missing: [] },
      participatingSources: [], nominations: [], poll: null, result: null,
      winnerIds: [], winnerTexts: [], recordHash: null, finalDigest: null,
      lemma: null, anchor: null, chainMode: "none", rejected: causalOrder.cyclicHashes.map((hash) => ({ hash, type: "?", reason: "event is part of a causal dependency cycle" })),
      conflictedSources: [...new Set([...conflictedSources, ...sources])].sort(compareStrings),
      invalidTransitions: [], eventCount: all.length,
    });
  }


  const starts = all.filter((event) => event.type === "process-start" && !forked.has(event.source));
  if (starts.length === 0) {
    return finish({
      process: "", name: "", question: "", status: "unstarted", phase: "unstarted",
      blocked: "start", quorum: { required: 1, sources: null, met: false, missing: [] },
      participatingSources: [], nominations: [], poll: null, result: null,
      winnerIds: [], winnerTexts: [], recordHash: null, finalDigest: null,
      lemma: null, anchor: null, chainMode: "none", rejected,
      conflictedSources, invalidTransitions: [], eventCount: all.length,
    });
  }

  const start = starts[0];
  const process = start.process;
  const rootCapability = start.payload.rootCapability;
  const rootScope = parseQosCapabilityScope(start.payload.scope);
  const name = typeof start.payload.name === "string" ? start.payload.name : process;
  const question = typeof start.payload.question === "string"
    ? start.payload.question
    : typeof start.payload.name === "string" ? start.payload.name : process;

  if (starts.length > 1) {
    return finish({
      process, name, question, status: "conflicted", phase: "conflicted",
      blocked: "multiple-process-start", quorum: { required: 1, sources: null, met: false, missing: [] },
      participatingSources: [], nominations: [], poll: null, result: null,
      winnerIds: [], winnerTexts: [], recordHash: null, finalDigest: null,
      lemma: null, anchor: null, chainMode: "none", rejected,
      conflictedSources: [...new Set([...conflictedSources, ...starts.map((event) => event.source)])].sort(compareStrings),
      invalidTransitions: [], eventCount: all.length,
    });
  }
  if (forked.has(start.source)) {
    return finish({
      process, name, question, status: "conflicted", phase: "conflicted",
      blocked: "root-source-forked", quorum: { required: 1, sources: null, met: false, missing: [] },
      participatingSources: [], nominations: [], poll: null, result: null,
      winnerIds: [], winnerTexts: [], recordHash: null, finalDigest: null,
      lemma: null, anchor: null, chainMode: "none", rejected,
      conflictedSources, invalidTransitions: [], eventCount: all.length,
    });
  }
  if (typeof rootCapability !== "string" || !rootScope || rootScope.process !== process) {
    return finish({
      process, name, question, status: "conflicted", phase: "conflicted",
      blocked: "invalid-process-start", quorum: { required: 1, sources: null, met: false, missing: [] },
      participatingSources: [], nominations: [], poll: null, result: null,
      winnerIds: [], winnerTexts: [], recordHash: null, finalDigest: null,
      lemma: null, anchor: null, chainMode: "none", rejected,
      conflictedSources, invalidTransitions: [], eventCount: all.length,
    });
  }

  const byHash = new Map(all.map((event) => [event.hash, event]));

  // Resolve every event's authority first. An event with a valid dyncap chain but
  // no valid grant is not orchestration input; it is reported, not guessed at.
  const resolved = new Map<string, ResolvedCapability>();
  for (const event of all) {
    if (event === start) {
      const own = resolveCapability(byHash, start, event);
      if (!own.ok) rejected.push({ hash: event.hash, type: event.type, reason: own.reason });
      else resolved.set(event.hash, own.cap);
      continue;
    }
    const result = resolveCapability(byHash, start, event);
    if (result.ok) resolved.set(event.hash, result.cap);
    else rejected.push({ hash: event.hash, type: event.type, reason: result.reason });
  }
  rejected.sort((a, b) => compareStrings(a.hash, b.hash));

  // Lifecycle transitions must carry root-capability dyncap attribution. Invalid transitions are reported
  // and skipped; a later valid transition still applies.
  const lifecycle = all
    .filter((event) => LIFECYCLE_TYPES.has(event.type) && event.source === start.source && resolved.has(event.hash))
    .sort((a, b) => (a.seq - b.seq) || compareStrings(a.hash, b.hash));
  let status: QosProcessView["status"] = "running";
  const invalidTransitions: { hash: string; reason: string }[] = [];
  for (const event of lifecycle) {
    if (event.hash === start.hash) continue;
    const cap = resolved.get(event.hash);
    if (!cap || event.capability !== rootCapability) {
      invalidTransitions.push({ hash: event.hash, reason: "lifecycle transition did not carry the root capability" });
      continue;
    }
    if (event.type === "process-suspend") {
      if (status === "running") status = "suspended";
      else invalidTransitions.push({ hash: event.hash, reason: `cannot suspend from ${status}` });
    } else if (event.type === "process-resume") {
      if (status === "suspended") status = "running";
      else invalidTransitions.push({ hash: event.hash, reason: `cannot resume from ${status}` });
    } else if (event.type === "process-terminate") {
      if (status === "running" || status === "suspended") status = "terminated";
      else invalidTransitions.push({ hash: event.hash, reason: `cannot terminate from ${status}` });
    }
  }

  const participants = stringArray(start.payload.participants);
  const participantSet = participants ? new Set(participants) : null;
  const inMembership = (event: QosEvent): boolean => !participantSet || participantSet.has(event.source);
  const valid = all.filter((event) => resolved.has(event.hash) && inMembership(event));
  const participatingSources = [...new Set([start.source, ...valid.map((event) => event.source)])].sort(compareStrings);

  const declaredQuorum = parseQuorum(start.payload.quorum);
  const required = Math.max(1, declaredQuorum.required, participants?.length ?? 0);
  const missing = (declaredQuorum.sources ?? participants ?? [])
    .filter((source) => !participatingSources.includes(source))
    .sort(compareStrings);
  const quorumMet = participatingSources.length >= required && missing.length === 0;

  const base = {
    process, name, question, status,
    quorum: { required, sources: declaredQuorum.sources, met: quorumMet, missing },
    participatingSources,
    conflictedSources,
    invalidTransitions,
    eventCount: all.length,
  };

  if (!quorumMet) {
    return finish({
      ...base, phase: "nominations", blocked: "quorum",
      nominations: [], poll: null, result: null, winnerIds: [], winnerTexts: [],
      recordHash: null, finalDigest: null, lemma: null, anchor: null,
      chainMode: "none", rejected,
    });
  }

  // Nominations: content-hashed options, not positions. Two peers that receive
  // the same nominations get the same ids no matter what order they arrived.
  const nominationsById = new Map<string, { id: string; text: string; by: Set<string> }>();
  for (const event of valid.filter((e) => e.type === "nomination")) {
    const option = event.payload.option;
    if (typeof option !== "string" || option.trim().length === 0) continue;
    const text = option.trim().replace(/\s+/g, " ");
    const id = optionId(text);
    const existing = nominationsById.get(id);
    if (existing) existing.by.add(event.source);
    else nominationsById.set(id, { id, text, by: new Set([event.source]) });
  }
  const nominations = [...nominationsById.values()]
    .map((n) => ({ id: n.id, text: n.text, by: [...n.by].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.id, b.id));

  const minNominations = Math.max(1, intOr(start.payload.minNominations, 2));
  const pollOpen = valid
    .filter((e) => e.type === "poll-open")
    .sort((a, b) => (a.seq - b.seq) || compareStrings(a.hash, b.hash))[0];

  if (nominations.length < minNominations) {
    return finish({
      ...base, phase: "nominations", blocked: "nominations",
      nominations, poll: null, result: null, winnerIds: [], winnerTexts: [],
      recordHash: null, finalDigest: null, lemma: null, anchor: null,
      chainMode: "none", rejected,
    });
  }
  if (!pollOpen) {
    return finish({
      ...base, phase: "nominations", blocked: "poll-open",
      nominations, poll: null, result: null, winnerIds: [], winnerTexts: [],
      recordHash: null, finalDigest: null, lemma: null, anchor: null,
      chainMode: "none", rejected,
    });
  }

  const method = typeof pollOpen.payload.method === "string" ? pollOpen.payload.method : "ranked";
  const pollQuestion = typeof pollOpen.payload.question === "string" ? pollOpen.payload.question : question;
  if (method !== "ranked") {
    return finish({
      ...base, question: pollQuestion, phase: "polling", blocked: "unsupported-method",
      nominations, poll: null, result: null, winnerIds: [], winnerTexts: [],
      recordHash: null, finalDigest: null, lemma: null, anchor: null,
      chainMode: "none", rejected,
    });
  }

  const optionIds = new Set(nominations.map((n) => n.id));
  const ballotBySource = new Map<string, { event: QosEvent; ranks: string[] }>();
  for (const event of valid.filter((e) => e.type === "ballot")) {
    const raw = event.payload.ranks;
    if (!Array.isArray(raw)) continue;
    const seen = new Set<string>();
    const ranks: string[] = [];
    for (const rank of raw) {
      if (typeof rank !== "string" || !optionIds.has(rank) || seen.has(rank)) continue;
      seen.add(rank);
      ranks.push(rank);
    }
    const prior = ballotBySource.get(event.source);
    if (!prior || event.seq > prior.event.seq ||
        (event.seq === prior.event.seq && compareStrings(event.hash, prior.event.hash) > 0)) {
      ballotBySource.set(event.source, { event, ranks });
    }
  }
  const ballots: Record<string, string[]> = {};
  for (const source of [...ballotBySource.keys()].sort(compareStrings)) {
    ballots[source] = ballotBySource.get(source)!.ranks;
  }
  const ballotCount = Object.keys(ballots).length;
  const minBallots = Math.max(1, intOr(pollOpen.payload.minBallots, 1));
  const pollView = {
    question: pollQuestion,
    method,
    optionIds: nominations.map((n) => n.id),
    ballotCount,
    ballots,
  };

  const pollClose = valid
    .filter((e) => e.type === "poll-close")
    .sort((a, b) => (a.seq - b.seq) || compareStrings(a.hash, b.hash))[0];
  if (ballotCount < minBallots) {
    return finish({
      ...base, question: pollQuestion, phase: "polling", blocked: "ballots",
      nominations, poll: pollView, result: null, winnerIds: [], winnerTexts: [],
      recordHash: null, finalDigest: null, lemma: null, anchor: null,
      chainMode: "none", rejected,
    });
  }
  if (!pollClose) {
    return finish({
      ...base, question: pollQuestion, phase: "polling", blocked: "poll-close",
      nominations, poll: pollView, result: null, winnerIds: [], winnerTexts: [],
      recordHash: null, finalDigest: null, lemma: null, anchor: null,
      chainMode: "none", rejected,
    });
  }

  // The ranked tally is the existing polls.ts reducer: joiner-local, no
  // central counter, and deterministic for the same (options, ballots).
  const pollOptions: PollOption[] = nominations.map((n) => ({
    id: n.id,
    text: n.text,
    by: n.by[0] ?? start.source,
    at: 0,
  }));
  const poll: Poll = {
    id: process,
    question: pollQuestion,
    options: pollOptions,
    method: "ranked",
    creator: start.source,
    creatorLabel: name,
    createdAt: 0,
    status: "closed",
    ballots,
  };
  const result = tallyRanked(poll);
  const record: AnchoredRecord = {
    process,
    question: pollQuestion,
    options: nominations.map((n) => ({ id: n.id, text: n.text })),
    ballots: Object.entries(ballots).sort((a, b) => compareStrings(a[0], b[0])),
    result,
  };
  const recordHash = await sha256Hex(canonicalJson(record));
  const winnerTexts = result.winners
    .map((id) => nominationsById.get(id)?.text ?? id)
    .sort(compareStrings);

  const lemmaEvent = valid
    .filter((e) => e.type === "lemma")
    .sort((a, b) => (a.seq - b.seq) || compareStrings(a.hash, b.hash))
    .find((e) => e.payload.recordHash === recordHash &&
      typeof e.payload.name === "string" && typeof e.payload.text === "string");
  if (!lemmaEvent) {
    return finish({
      ...base, question: pollQuestion, phase: "tally", blocked: "lemma",
      nominations, poll: pollView, result,
      winnerIds: result.winners, winnerTexts, recordHash, finalDigest: null,
      lemma: null, anchor: null, chainMode: "none", rejected,
    });
  }

  const lemma = {
    name: lemmaEvent.payload.name as string,
    text: lemmaEvent.payload.text as string,
    by: lemmaEvent.source,
    recordHash,
  };

  const anchorEvent = valid
    .filter((e) => e.type === "anchor")
    .sort((a, b) => (a.seq - b.seq) || compareStrings(a.hash, b.hash))
    .find((e) => e.payload.recordHash === recordHash &&
      typeof e.payload.chain === "string" &&
      typeof e.payload.deployId === "string" &&
      e.payload.deployId.length > 0);
  if (!anchorEvent) {
    return finish({
      ...base, question: pollQuestion, phase: "recorded", blocked: null,
      nominations, poll: pollView, result,
      winnerIds: result.winners, winnerTexts, recordHash, finalDigest: recordHash,
      lemma, anchor: null, chainMode: "none", rejected,
    });
  }

  const anchor = {
    chain: anchorEvent.payload.chain as string,
    deployId: anchorEvent.payload.deployId as string,
    blockHash: typeof anchorEvent.payload.blockHash === "string" ? anchorEvent.payload.blockHash : undefined,
    recordHash,
    by: anchorEvent.source,
  };
  return finish({
    ...base, question: pollQuestion, phase: "anchored", blocked: null,
    nominations, poll: pollView, result,
    winnerIds: result.winners, winnerTexts, recordHash, finalDigest: recordHash,
    lemma, anchor, chainMode: "anchor-event", rejected,
  });
}

async function finishView(
  view: Omit<QosProcessView, "stateDigest" | "brokenChains">,
  events: QosEvent[],
): Promise<QosProcessView> {
  const complete = { ...view, brokenChains: brokenChainsIn(events) };
  const stateDigest = await sha256Hex(canonicalJson(complete));
  return { ...complete, stateDigest };
}

// ---------------------------------------------------------------------------
// Room adapter
// ---------------------------------------------------------------------------

/// The subset of `QOSPeer` this adapter needs. The browser peer's
/// `broadcast(data)` is the control-plane path; a test can inject a memory bus.
export interface QosTransport {
  broadcast(data: unknown, opts?: { bulk?: boolean }): void;
  send?(target: string, data: unknown, opts?: { bulk?: boolean }): boolean;
}

export interface QosProcessRoomConfig {
  roomId: string;
  identity: DynCapState;
  transport: QosTransport;
  log?: QosEventLog;
  signer?: QosEventSigner;
}

export interface QosProcessStartOptions {
  question?: string;
  quorum?: { required?: number; sources?: string[] };
  participants?: string[];
  minNominations?: number;
  entropyHex?: string;
  /// Escape hatch for a legacy/cached room token that predates the ZFA check:
  /// pass an already-valid process-root capability instead of deriving from
  /// the room token. The root is still capability-guarded and bound to this
  /// room's dyncap identity.
  rootCapability?: string;
  scope?: QosCapabilityScope;
}

/// A process name + root capability, hashed into a stable, readable id. This is
/// naming, not a security boundary; the capability is the authority.
export function processIdFor(name: string, rootCapability: string): string {
  let a = 5381;
  let b = 52711;
  const text = `${name}\u0000${rootCapability}`;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = ((a << 5) + a + code) >>> 0;
    b = ((b << 4) + b + code) >>> 0;
  }
  return `qos:proc:${a.toString(36)}${b.toString(36)}`;
}

function capabilityOfGrant(grantEvent: QosEvent): string {
  if (grantEvent.type === "process-start") return grantEvent.capability;
  if (grantEvent.type === "capability-grant") {
    const child = grantEvent.payload.childCapability;
    if (typeof child === "string") return child;
  }
  throw new Error("capabilityOfGrant: event does not carry a grantable capability");
}

function grantReference(grantEvent: QosEvent): string {
  return grantEvent.type === "process-start" ? "root" : grantEvent.hash;
}

/// The thin room-facing wrapper. It signs one event at a time with the caller's
/// persistent dyncap identity, ingests what it emits locally, and broadcasts the
/// same JSON object a `QOSPeer` or a rholalc consumer receives. It owns no
/// process state; `view()` is always recomputed from the log.
export class QosProcessRoom {
  readonly log: QosEventLog;
  readonly signer: QosEventSigner;

  constructor(readonly config: QosProcessRoomConfig) {
    this.log = config.log ?? new QosEventLog(config.roomId);
    this.signer = config.signer ?? new QosEventSigner(config.identity, config.roomId, (process, source) => {
      const events = this.log.eventsFor(process).filter((event) => event.source === source);
      return events.length > 0 ? events[events.length - 1].hash : undefined;
    });
  }

  private async publish(event: QosEvent): Promise<QosEvent> {
    const result = await this.log.ingest(event);
    if (!result.ok && !result.duplicate) {
      throw new Error(`publish: local log rejected ${event.type}: ${result.reason ?? "unknown reason"}`);
    }
    this.config.transport.broadcast(event);
    return event;
  }

  async startProcess(
    name: string,
    opts: QosProcessStartOptions = {},
  ): Promise<{ event: QosEvent; processId: string; capability: string; scope: QosCapabilityScope }> {
    const rootCapability = opts.rootCapability ?? deriveProcessCapability(this.config.roomId, opts.entropyHex);
    const processId = processIdFor(name, rootCapability);
    const scope = opts.scope ?? newRootScope(processId);
    if (scope.process !== processId) {
      throw new Error("startProcess: scope does not name this process");
    }
    const payload: Record<string, unknown> = {
      name,
      question: opts.question ?? name,
      rootCapability,
      scope,
      quorum: opts.quorum ?? { required: opts.participants?.length ?? 1 },
      minNominations: opts.minNominations ?? 2,
    };
    if (opts.participants) payload.participants = opts.participants;
    const event = await this.signer.sign(processId, rootCapability, "root", "process-start", payload);
    await this.publish(event);
    return { event, processId, capability: rootCapability, scope };
  }

  /// Grant a narrowed child capability. `parentEvent` is the process-start
  /// event (root capability) or an existing capability-grant event (its child
  /// capability is the parent).
  async grant(
    processId: string,
    parentEvent: QosEvent,
    to: string,
    childScope: QosCapabilityScope,
    entropyHex?: string,
  ): Promise<{ event: QosEvent; capability: string; scope: QosCapabilityScope }> {
    if (parentEvent.process !== processId) throw new Error("grant: parent event belongs to a different process");
    const parentCapability = capabilityOfGrant(parentEvent);
    const parentScope = parentEvent.type === "process-start"
      ? parseQosCapabilityScope(parentEvent.payload.scope)
      : parseQosCapabilityScope(parentEvent.payload.childScope);
    if (!parentScope) throw new Error("grant: parent capability has no valid scope");
    const scope: QosCapabilityScope = { ...childScope, process: processId };
    const narrowed = attenuateScope(parentScope, scope);
    if (!narrowed) throw new Error("grant: scope would broaden the parent capability");
    const capability = deriveProcessCapability(parentCapability, entropyHex);
    const event = await this.signer.sign(processId, parentCapability, grantReference(parentEvent), "capability-grant", {
      to,
      childCapability: capability,
      childScope: narrowed,
    });
    await this.publish(event);
    return { event, capability, scope: narrowed };
  }

  async emit(
    processId: string,
    grantEvent: QosEvent,
    type: QosEventType,
    payload: Record<string, unknown>,
  ): Promise<QosEvent> {
    if (grantEvent.process !== processId) throw new Error("emit: grant event belongs to a different process");
    const event = await this.signer.sign(
      processId,
      capabilityOfGrant(grantEvent),
      grantReference(grantEvent),
      type,
      payload,
    );
    return this.publish(event);
  }

  nominates(processId: string, grantEvent: QosEvent, option: string): Promise<QosEvent> {
    return this.emit(processId, grantEvent, "nomination", { option });
  }

  openPoll(
    processId: string,
    grantEvent: QosEvent,
    opts: { question?: string; minBallots?: number } = {},
  ): Promise<QosEvent> {
    return this.emit(processId, grantEvent, "poll-open", {
      method: "ranked",
      ...(opts.question !== undefined ? { question: opts.question } : {}),
      ...(opts.minBallots !== undefined ? { minBallots: opts.minBallots } : {}),
    });
  }

  castsBallot(processId: string, grantEvent: QosEvent, ranks: string[]): Promise<QosEvent> {
    return this.emit(processId, grantEvent, "ballot", { ranks });
  }

  closePoll(processId: string, grantEvent: QosEvent, reason?: string): Promise<QosEvent> {
    return this.emit(processId, grantEvent, "poll-close", reason ? { reason } : {});
  }

  async recordLemma(processId: string, grantEvent: QosEvent, name?: string): Promise<QosEvent> {
    const view = await this.view(processId);
    if (!view.recordHash) throw new Error("recordLemma: no tally record yet");
    const text = outcomeText(view);
    return this.emit(processId, grantEvent, "lemma", {
      name: name ?? view.name,
      text,
      recordHash: view.recordHash,
    });
  }

  async anchor(
    processId: string,
    grantEvent: QosEvent,
    anchor: { chain: string; deployId: string; blockHash?: string },
  ): Promise<QosEvent> {
    const view = await this.view(processId);
    if (!view.recordHash) throw new Error("anchor: no tally record yet");
    return this.emit(processId, grantEvent, "anchor", { ...anchor, recordHash: view.recordHash });
  }

  suspend(processId: string, startEvent: QosEvent, reason?: string): Promise<QosEvent> {
    return this.emit(processId, startEvent, "process-suspend", reason ? { reason } : {});
  }

  resume(processId: string, startEvent: QosEvent, reason?: string): Promise<QosEvent> {
    return this.emit(processId, startEvent, "process-resume", reason ? { reason } : {});
  }

  terminate(processId: string, startEvent: QosEvent, reason?: string): Promise<QosEvent> {
    return this.emit(processId, startEvent, "process-terminate", reason ? { reason } : {});
  }

  /// Find the grant that lets `source` act, for this process. A room of peers
  /// can all read the same grant events; the grant is still bound to `source`,
  /// so another peer cannot use it in a valid event.
  findGrant(processId: string, source: string): QosEvent | undefined {
    const grants = this.log.eventsFor(processId)
      .filter((event) => event.type === "capability-grant" && event.payload.to === source)
      .sort((a, b) => (b.seq - a.seq) || compareStrings(b.hash, a.hash));
    if (grants.length > 0) return grants[0];
    return this.log.eventsFor(processId).find(
      (event) => event.type === "process-start" && event.source === source,
    );
  }

  async view(processId: string): Promise<QosProcessView> {
    return orchestrate(this.log.eventsFor(processId), {
      forkedSources: this.log.forkedSources,
      process: processId,
    });
  }

  /// Feed one inbound envelope. Returns true when it was accepted (or already
  /// known), false when it was rejected or was not a QOS event.
  async onMessage(_from: string, data: unknown): Promise<boolean> {
    const event = parseQosEvent(data);
    if (!event) return false;
    const result = await this.log.ingest(event);
    return result.ok;
  }
}

/// Merge helper for a peer that was offline or refused a relay: once the same
/// envelopes are present, the reducer converges on the same view. There is no
/// privileged orchestrator to ask; any peer can serve the missing events.
export async function mergeEventLogs(target: QosEventLog, source: QosEventLog): Promise<IngestResult[]> {
  return target.mergeFrom(source);
}
