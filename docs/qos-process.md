# QOS process orchestration (PR gate quantum-os#264)

QOS for Rholo proposes that the room's existing primitives are enough for
long-lived processes: named, capability-guarded continuations that compose
`/poll`-style decisions, lemmas, and an optional chain anchor without adding a
consensus layer, a clock, or a trusted orchestrator.

This page is the contract for the gate. The implementation is
[`packages/browser/src/qos-process.ts`](../packages/browser/src/qos-process.ts);
the reproducible two-peer exercise is
[`packages/browser/test/qos-process.test.mjs`](../packages/browser/test/qos-process.test.mjs).

**Scope status:** the event model, lifecycle, reducer, failure behaviour, and
security checks are implemented and tested. The browser app does not yet expose
a `/qos` UI; `QosProcessRoom` is the room-facing adapter a UI or agent would
use. No chain RPC is added anywhere.

---

## What a process is

A process is a **name + a ZFA capability + an append-only event log**. It owns
no hidden state: every peer that has the same envelopes computes the same view.

```
process-start (root capability, scope, quorum)
  ├─ capability-grant  → participant A gets nomination/ballot only
  ├─ capability-grant  → participant B gets nomination/ballot only
  ├─ nomination        → A nominates "Alpha"
  ├─ nomination        → B nominates "Beta"
  ├─ poll-open         → ranked method, minimum ballots
  ├─ ballot            → A ranks [alpha, beta]
  ├─ poll-close        → root holder closes the poll
  ├─ lemma             → signed lemma-of-record, carries recordHash
  └─ anchor            → optional already-produced rholo deploy reference
```

Lifecycle events (`process-start`, `process-suspend`, `process-resume`,
`process-terminate`) are themselves signed events. Suspending a process is not
a local UI state; it is a capability-guarded event every peer can verify.

## Event model

One finite schema: `qos.event/1`. `parseQosEvent` / `decodeQosEvent` reject an
unknown schema, an unknown type, an unknown field, or an unbalanced action
history. There is no translation layer that guesses.

| Field | Meaning |
|---|---|
| `kind` | Always `"qos-event"`. |
| `schema` | Always `"qos.event/1"`. |
| `type` | One of the finite event types below. |
| `process` | Process id, derived from the process name and root capability. |
| `source` | The emitter's stable dyncap anchor. A transport peer id is not identity. |
| `capability` | The ZFA capability presented for this event. |
| `grant` | `"root"` for the process-start/root holder, or the hash of the `capability-grant` event that issued the capability. |
| `seq` | Per-source sequence, equal to `dyncap.seq`. |
| `prev` | Previous event hash from this source **within this process**, or `"genesis"`. |
| `payload` | Type-specific body (an object, never an opaque string). |
| `payloadHash` | SHA-256 of the canonical payload. |
| `zfa` | A small ZFA-balanced action history derived from `payloadHash`. |
| `hash` | SHA-256 of the canonical event without `hash` and `dyncap`. |
| `dyncap` | Existing `{anchor, seq, witness}` chain link from `dyncap.ts`. |

The finite event vocabulary:

| Type | Purpose |
|---|---|
| `process-start` | Creates the named process and its root capability/scope. |
| `process-suspend` | Root-signed transition running → suspended. |
| `process-resume` | Root-signed transition suspended → running. |
| `process-terminate` | Root-signed terminal transition. |
| `capability-grant` | Parent capability issues a narrowed child capability to one source. |
| `nomination` | Source proposes an option for the ranked poll. |
| `poll-open` | Root-signed: ranked method, question, minimum ballots. |
| `ballot` | Source casts a ranked list of option ids. |
| `poll-close` | Root-signed: stop accepting ballots. |
| `lemma` | Root-signed lemma-of-record carrying the tally `recordHash`. |
| `anchor` | Optional, anchor-authorized event carrying a deploy reference. |

Canonical JSON sorts object keys recursively and preserves array order. Both a
room peer and a rholo/rholalc consumer hash the same bytes, so a payload hash
does not depend on the serializer.

### rholo / rholalc boundary

The room adapter broadcasts the event object directly:

```ts
const room = new QosProcessRoom({ roomId, identity, transport: peer });
await room.startProcess("nominate-and-rank", { question, quorum, participants });
peer.onMessage = (from, data) => room.onMessage(from, data);
```

A rholo/rholalc consumer reads the same JSON and calls:

```ts
const event = decodeQosEvent(json);      // strict shape check, null on refusal
if (!event) return;                       // no silent translation
const log = new QosEventLog(roomId);
await log.ingest(event);                  // hash/dyncap/ZFA verification
```

`QosEventLog` is the verification boundary; `parseQosEvent` alone does not make
the dyncap or hash guarantees. There is no second event shape and no field
renaming between the room and a consumer.

## Capabilities and attenuation

- A capability token is a ZFA token (`zfa.ts` `validateCapability`).
- A process root capability is derived from the room token by appending
  conjugate twist pairs. The child's twist string starts with the parent's, so
  attenuation is structural: `isCapabilityAttenuated(parent, child)`.
  `startProcess({ rootCapability })` accepts an already-valid process root for a
  legacy/cached room token that predates the ZFA check; the root is still
  capability-guarded and bound to the room's dyncap identity.
- A grant carries a scope:

  ```ts
  interface QosCapabilityScope {
    process: string;
    events: QosEventType[];   // nomination/ballot, etc.
    canLifecycle: boolean;    // start/suspend/resume/terminate
    canGrant: boolean;        // issue narrower grants
    canClose: boolean;        // poll-open/poll-close/lemma
    canAnchor: boolean;       // emit an anchor event
  }
  ```

- `attenuateScope(parent, child)` refuses any added event type or right. A
  child may always narrow, never broaden.
- Every event is bound to a source. A grant names `to` (a dyncap anchor) and
  the event's `source` must equal it. The token may be public inside the room;
  using it from another identity is rejected by the reducer.
- A capability chain is resolved from `grant` links back to the
  `process-start` event. Missing, cyclic, over-deep, or broadening chains are
  rejected into `view.rejected` rather than guessed at.

### Trust ceiling (honest scope)

This uses the existing dyncap identity: TOFU plus chain-tamper/replay/fork
detection. It is not a signature scheme and does not prove a witness was
derived from a seed; see the note at the top of
[`dyncap.ts`](../packages/browser/src/dyncap.ts). It is sufficient for the
gate's local, capability-guarded orchestration; it is not a Byzantine consensus
proof.

## Process identity and lifecycle

`processIdFor(name, rootCapability)` hashes the name and root token into a
stable `qos:proc:…` id. The id is naming, not security; the capability is the
authority.

The reducer applies lifecycle transitions in source sequence order:

```
process-start          → running
running   + suspend    → suspended
suspended + resume     → running
running|suspended + terminate → terminated (terminal)
```

An invalid transition is reported in `view.invalidTransitions` and skipped; a
later valid transition still applies. Lifecycle events from another source, or
without the root capability, are rejected. The process's action history is the
concatenation of its events' `zfa` histories and still achieves ZFA.

## Deterministic orchestration

`orchestrate(events)` is a pure reducer over a verified event set. It computes:

1. **Nominations** — options are content-hashed (`optionId`), not positional.
   Duplicates collapse; order is by option id.
2. **Ranked poll** — ballots are cleaned to known option ids, one per source
   (highest sequence wins), and tallied by the existing `polls.ts`
   `tallyRanked` reducer.
3. **Lemma-of-record** — the record is `{process, question, options, ballots,
   result}`; `recordHash` is its canonical SHA-256. A `lemma` event must carry
   that exact hash.
4. **Optional anchor** — an `anchor` event must carry the same `recordHash` and
   a non-empty deploy id. Without one the process stops at `recorded`.

The view exposes `stateDigest` (SHA-256 of the whole view) and `finalDigest`
(the record hash once a lemma is recorded). Same envelopes ⇒ same digests, no
matter the arrival order or which peer runs the reducer.

## Failure and partial participation

There is no trusted orchestrator to ask, so the reducer reports what it can and
never invents the rest.

| Condition | Behaviour |
|---|---|
| **Peer offline** | Its events are absent. `quorum.missing` names it, `view.blocked` is `quorum`, and no lemma/final digest is produced. A process may legitimately stay held. |
| **Relay refuses / drops an event** | The source's per-process `prev` chain has a hole; `view.brokenChains` reports it and the phase cannot advance past the missing event. Any peer can serve the missing envelopes later; `mergeEventLogs` converges on the same digests. |
| **Conflicting sequences** | Two different events at the same `(source, seq)` are a fork. The source is quarantined (`forkedSources`) and excluded from the reducer. No peer chooses a "real" branch. |
| **Missing capability grant** | The event is accepted by the log only if its envelope is valid; the reducer rejects it into `view.rejected` with the reason. |
| **Root source forked** | The process is `conflicted`; no lifecycle or record is claimed. |
| **Multiple process-start events** | The process is `conflicted`; the reducer does not pick a winner. |

Liveness is not guaranteed. The gate asks for documented failure behaviour, not
a clock or a leader. A process held at quorum is visibly held.

## Security invariant

Every event:

- has a `zfa` action history that achieves ZFA (existing `achievesZfa`
  predicate);
- is hash-bound to its payload and to its `prev` event;
- carries a valid ZFA capability;
- resolves through a grant chain that only narrows.

A process's concatenated action history is still ZFA because it is a
composition of ZFA histories. The tests assert this for the lifecycle run and
the full orchestration.

**Lean obligations:** none added. This module asserts no new axiom and states
no new theorem. It calls the existing `achievesZfa` /
`validateCapability` predicates whose Rust counterpart is pinned by
[`crates/zfa-core/tests/census_conformance.rs`](../crates/zfa-core/tests/census_conformance.rs).
If a future revision adds a proof obligation, it must be registered and audited
before merge; this PR does not.

## Boundary with the chain

The reducer never calls a node. The two supported modes are:

- **zero chain calls** — no `anchor` event; the process completes at
  `recorded` with `chainMode: "none"`.
- **only chain calls** — an operator produces a deploy reference out of band and
  emits an `anchor` event carrying `{chain, deployId, blockHash?, recordHash}`.
  The reducer verifies the `recordHash` and exposes the anchor; it does not
  perform the deploy.

Both modes are exercised in the test. rholo chain interaction remains opt-in;
nothing here requires a chain, and no new consensus or mandatory anchoring is
introduced.

## Reproduce

```bash
node packages/browser/test/qos-process.test.mjs
```

The script bundles the TypeScript module with `esbuild` (already a browser
devDependency), creates three independent dyncap identities, runs the
composition, feeds the same envelopes to independent logs in forward and
reverse order, and asserts identical `stateDigest`/`finalDigest`. It also
covers:

- signed lifecycle transitions;
- offline peer / quorum hold / relay-gap recovery;
- source fork quarantine;
- payload tamper, source relabelling, unbalanced ZFA;
- capability broadening and cross-source use;
- strict parser round-trip for the rholalc-facing JSON;
- zero-chain and anchor-event modes.

The test is part of CI (see `.github/workflows/ci.yml`).

## Browser `/qos` command

The merged contract is reachable from a room with a thin command surface:

```text
/qos start <name> [| <question>]
/qos status [name|id]
/qos suspend <name|id> [| reason]
/qos resume <name|id> [| reason]
/qos terminate <name|id> [| reason]
```

`qos-command.ts` owns only the command text, process-name resolution, and the
chat lines; `QosProcessRoom` still signs every lifecycle event with the
browser's dyncap identity and broadcasts the same `qos.event/1` object every
peer verifies. Only the process owner can drive its lifecycle; a peer that
merely saw the start event can read the state but cannot suspend/resume/
terminate it. `/qos status` reports the full deterministic `stateDigest`.

`qos-command.test.mjs` starts a process on one identity, feeds the same events
to a second identity, and asserts both reducers agree on the state digest after
start, suspend, resume and terminate. It is part of CI.

## Gate criteria mapping

| Gate | How this PR closes it |
|---|---|
| 1. Event model | `QosEvent` / `qos.event/1`, finite `QOS_EVENT_TYPES`, canonical payload hash, strict `parseQosEvent`, `QosProcessRoom` broadcasts the same object to a `QOSPeer`; `decodeQosEvent` is the rholalc boundary. |
| 2. Process identity | `processIdFor`, root/child ZFA capabilities, signed `process-start`/`suspend`/`resume`/`terminate`, hash chain, grant resolution. |
| 3. Orchestration | `orchestrate` runs nominations → ranked poll → lemma-of-record → optional anchor end to end; test shows identical digests on independent peers. |
| 4. Failure & partial participation | `quorum.missing`, `blocked`, `brokenChains`, `forkedSources`, `conflictedSources`, `rejected`; documented above; no trusted orchestrator. |
| 5. Security invariant | Every event ZFA-checked; capability attenuation and source binding enforced; no new axiom; no new Lean obligation. |
| 6. Boundary with chain | Reducer has no chain RPC; zero-chain and anchor-event modes both tested; chain remains opt-in. |
| 7. Test | `node packages/browser/test/qos-process.test.mjs`, reproducible, two independent reducers, identical outcome; wired into CI. |

## Out of scope

- A full `/qos` UI or a dedicated agent role; the `/qos` command and the `QosProcessRoom` adapter are the seam.
- Complete consensus, finality, or Byzantine fault tolerance.
- Replacement of `/gov` or `/poll` semantics; the reducer reuses `polls.ts`.
- Performance optimization, media, or UI.
- A physical clock. The module has no time source; ordering is sequence/hash
  based. It makes no claim that block times are a clock.
- A separate rholalc implementation in another repository; this PR defines the
  finite JSON contract and the strict parser both sides use.

## Related

- [Architecture](architecture.md) — the room, ZFA kernel, signaling contracts.
- [Group Decisions](../Group_Decisions.md) — the existing `/poll` semantics the
  ranked reducer reuses.
- [Consensus](../Consensus.md) — what this gate deliberately does *not* claim.
- [SECURITY.md](../SECURITY.md) — dyncap trust ceiling, capability model.
