# QOS/1 ABI v0 — objects, handles, and syscalls

**Status:** v0 pure-TypeScript model (`packages/browser/src/qos-kernel.ts`), tracked by
[#277](https://github.com/rhovision-org/quantum-os/issues/277); journal wiring is
[#317](https://github.com/rhovision-org/quantum-os/issues/317). `qos.syscall/1` names the
operation/payload shape; it is **not a second journal**. The only canonical wire journal is
`qos.event/1`, and syscall requests, results, and refusals are finite event types inside it.
The shape is planned, not yet emitted.

The ABI is deliberately small. It is not a POSIX clone: capability handles replace
file descriptors and UIDs, and every operation is attributed to a process and a handle.

## Objects

| Object | Meaning |
|---|---|
| **Process** | a running continuation; has a PID, owner, parent, root handle, state |
| **Handle** | a per-process reference to an object with a rights mask |
| **Object** | anything a handle can name: room, file, process control, device, service |
| **Namespace** | a tree of names rooted at a handle; the VFS later mounts objects into it |
| **Signal** | a control event delivered to a process (`SIGTERM`, `SIGINT`, `SIGKILL`, `SIGCHLD`) |
| **Syscall** | a named, validated operation with a caller PID and a handle |

### Identity

- **PID** — `qos:proc:…`, the existing `processIdFor` value. The kernel test model also
  accepts short synthetic PIDs (`proc:1`) for isolated tests.
- **UID** — the dyncap anchor. There is no integer user database.
- **Object id** — the content hash for immutable objects; a `proc:<pid>` name for a
  process-control object; a mount name for a device/service object.
- **Handle id** — opaque and local to one process (`h:1`, `h:2`, …). A handle id from
  another process is not meaningful.

## Rights

```text
READ      read an object
WRITE     mutate an object
EXEC      execute / spawn from an object
SIGNAL    signal or wait on a process object
GRANT     derive or hand out a handle
REVOKE    revoke this handle and its descendants
ADMIN     kernel/bootstrap authority for a namespace root
```

Rights are a bitmask. **Attenuation rule:** a derived handle's rights must be a subset
of its parent's rights. A request for any bit the parent lacks is `EACCES`.

`ADMIN` is not a superuser. It is authority over one namespace root, granted at process
creation; it says nothing about another room or another process's handles.

## Process table

| Field | Meaning |
|---|---|
| `pid` | stable process id |
| `name` | human label |
| `owner` | dyncap anchor that created/owns the process |
| `parent` | creating process, or null for init |
| `state` | `running` · `exited` · `reaped` |
| `exitCode` | set on exit; negative signal number for a signal kill |
| `root` | handle id of the process's namespace root |
| `handles` | live handle ids |

The room-facing process table (`/qos status`, `/ps`) is a **view** of this kernel table
plus the dyncap-attributed `qos.event/1` journal. The kernel model is the authority for v0
tests; [#317](https://github.com/rhovision-org/quantum-os/issues/317) wires `/qos` and `/ps`
to kernel replay rather than a parallel `QosProcessRoom` model.

## Syscall table

v0 implements the process/capability rows. Rows marked *reserved* are in the ABI so
callers and docs agree on names and errno, but return `ENOTSUP` until the named layer
lands.

| Syscall | Args | Returns | Status |
|---|---|---|---|
| `getpid` | — | caller PID | v0 |
| `getppid` | — | parent PID or null | v0 |
| `spawn` | `handle`, `name` | child process | v0 |
| `exit` | `code` | — | v0 |
| `wait` | `childPid` | exit code | v0 |
| `signal` | `pid`, `signal` | — | v0 |
| `cap_derive` | `handle`, `rights` | narrower handle | v0 |
| `cap_revoke` | `handle` | revoked count | v0 |
| `cap_close` | `handle` | — | v0 |
| `open` | `object`, `rights`, `parent?` | handle | v0 (object handles) |
| `read` | `handle` | bytes/text | reserved generic ABI; bounded memory below |
| `write` | `handle`, `data` | bytes written | reserved; immutable content uses mem_put |
| `stat` | `handle` | object metadata | reserved — VFS #280 |
| `mkdir` / `unlink` / `rename` | path/handle args | — | reserved — VFS #280 |
| `mount` / `unmount` | handle/path | — | reserved — VFS #280 |
| `send` / `recv` | `handle`, bytes | — | reserved — IPC #281 |
| `listen` / `connect` / `accept` | address | handle | reserved — `posix-net` adapter #283 |
| `svc_register` / `svc_lookup` | name, handle | — / handle | reserved — init #284 |
| `yield` / `sleep` | — / logical ticks | schedule | cooperative scheduler #278 |
| `sched_step` / `sched_priority` / `sched_wake` | — / 0..3 / — | schedule | cooperative scheduler #278 |
| `log` | `level`, `message` | — | v0 (kernel trace) |

## Errors

| Errno | Meaning |
|---|---|
| `EACCES` | handle/rights refuse the operation, or the handle was revoked |
| `ENOENT` | no such process, object, handle, or child |
| `EBADF` | handle id is unknown or was closed |
| `EAGAIN` | operation would block (child still running, quota) |
| `EINVAL` | malformed request or invalid transition |
| `ENOTSUP` | ABI name exists but this layer is not implemented yet |

Errors are values, not exceptions. A kernel method returns
`{ ok: true, value }` or `{ ok: false, errno }`; callers must not rely on thrown errors
for control flow.

## Determinism

- No wall clock; `sleep`/`yield` use logical ticks (scheduler #278).
- No ambient randomness. Canonical handle IDs are allocation-event-derived; standalone fixture IDs use counters.
- Process iteration is sorted by `pid`; handle iteration by `handle id`.
- `stateDigest()` canonicalizes the process/handle table (sorted keys, sorted arrays)
  and hashes it with SHA-256.
- Journal order is causal first (`prev`, grants, object versions, process creation);
  otherwise-concurrent events order by `(source anchor, seq, hash)`. Arrival order is not an
  input.
- A replay is the same ordered operation sequence; two kernels that receive it must
  produce the same `stateDigest()`.

## Canonical syscall event payload (bounded #317 slice)

This is the payload shape carried inside a `qos.event/1` event. The bounded root-attributed implementation accepts getpid, getppid, cap_derive, cap_close, cap_revoke, signal_grant and signal. Broader ops remain planned.
`qos.syscall/1` never forms a parallel journal. The internal `qos.test-trace/1` harness is only a local test fixture: it is neither admitted to a room nor exposed as a public API. Its ordered test input does not establish network-order convergence; that remains a canonical event integration obligation.

```json
{
  "schema": "qos.event/1",
  "type": "syscall-request",
  "process": "qos:proc:…",
  "source": "cap:peer/dyn:…",
  "dyncap": { "anchor": "…", "seq": 42, "witness": "…" },
  "payload": {
    "schema": "qos.syscall/1",
    "caller": "qos:proc:…",
    "op": "cap_derive",
    "args": { "handle": "h:1", "rights": 3 }
  }
}
```

Abridged: the outer event also carries the usual `capability`, `grant`, `payloadHash`, `zfa`,
and `hash` fields. The finite event type vocabulary is defined by
[#317](https://github.com/rhovision-org/quantum-os/issues/317).

Validation order:

1. shape and finite `op`;
2. caller exists and is running;
3. handle exists, is live, and carries the required rights;
4. arguments are valid for the op;
5. the operation mutates only the caller's namespace or an object the handle names.

A refused syscall is a recorded `syscall-result` event carrying the errno, not a local-only
error, so every peer can audit and replay it. The result payload is
`{schema:"qos.syscall/1", requestHash, outcome}` and must directly follow that
request on the same process/source chain. A request is inert until a valid result
recomputes at its canonical position; false results cannot commit trial state.
A refused operation is a deterministic outcome, not a malformed-envelope rejection.
New process roots explicitly include both event types; existing roots without the
scope stay unauthorized. Older clients reject this event-vocabulary extension:
coordinate support before deployment. `/qos syscall <name|id> | <op> | <JSON args>`
exercises the bounded path; `/qos status` exposes the replayed kernel digest.
Replay refuses multiple starts for the same PID rather than selecting an owner,
requires the declared process identity/root scope, and checks lifecycle rights.
Canonical replay roots use `h:start:<process-start hash>`, and cap_derive
successes use `h:request:<syscall-request hash>`. Neither consumes the local
sequential handle allocator. This keeps IDs and outcomes stable when unrelated
earlier event chains arrive. The standalone kernel fixture API still uses local
numbered handles. Existing experimental canonical histories containing numbered
handle IDs have no automatic migration: coordinated clients must start a new
journal or explicitly migrate its receipts rather than reinterpret them.
A known caller-owned handle must additionally carry `args.handleVersion`, the
hash of its latest accepted creation or mutation event. Roots are stamped by
process-start; derived handles by successful results; close/revoke/termination
stamp affected handles, including tombstones. The dispatcher supplies the
observed version by default. Missing/stale/foreign versions fail replay;
a genuinely unknown caller handle without a version may yield EBADF. The
version index lives in the replay digest and is copied with speculative state.
Request/result and handle-version hashes are explicit causal dependencies,
not inferred from arbitrary strings. The bounded cross-process extension permits only target-owner consent:
`signal_grant` runs as the target process and names its own root as `handle`,
and the recipient PID as `target`. It creates a target-side SIGNAL|REVOKE
parent and a recipient-side SIGNAL-only handle to exactly the granting process,
with stable allocation IDs derived from the request hash. The recipient uses
`signal` with the exact handle, target PID, and finite signal name. Per #278, SIGKILL additionally requires the target owner (the caller and target share the owner anchor); delegated cross-owner SIGNAL alone cannot authorize SIGKILL. A refusal is journaled as EACCES. The
target-side revoker can revoke the delegated handle using `cap_revoke`.
A root with room-wide rights cannot itself signal a different process, and
generic `open` is not exposed as a journal syscall. Self-signal requires the
caller root. Terminating signals clear target handles; suspended children
cannot be reaped by wait.

Both new operations carry `targetVersion`, the observed receipt for the
target/recipient process lifecycle state (state, exit code, pending signals).
The process version index is replay-derived, cloned and hashed with kernel
state. Explicit process-version edges are included in the causal graph, and
both handle and process versions are rechecked before result commit. The
command adapter fills observed versions and rejects stale inputs before
publication. Kernel status is displayed separately from governance orchestration.

This is a bounded model of consensual control, not distributed authorization
finality or cryptographic source authentication. Concurrent conflicting
histories may invalidate prior speculative receipts; no monotonic acceptance
is claimed. General cross-process delegation, shared-object conflict policy,
actual execution dispatch, broader scheduler integration and VFS remain open.

## Cooperative scheduler (#278)

The pure `qos-scheduler.ts` model separates lifecycle authority from CPU-turn
accounting. A running kernel process is eligible for a scheduler task in
ready/running/blocked/zombie state. A suspended process is blocked; a sleeping
task is blocked until its logical deadline; exited/reaped processes are zombies.
Only accepted kernel lifecycle transitions change membership. The selected
task may spend one logical tick via `sched_step`, rotate via `yield`, sleep
for 1..1,000,000 logical ticks, or set its priority (0..3) and yield.
A quantum contains priority+1 turns. Ready arrivals join the tail; simultaneous
wakeups use bytewise PID order. With N continuously ready tasks a waiting task
has at most 4(N-1) completed turns of other tasks before selection, assuming
selected tasks cooperate; arrivals cannot jump ahead. Idle `sched_wake` by
an active sleeping task moves exactly to the earliest active sleep deadline.
No wall time or arbitrary caller-controlled clock advancement is used.

The five scheduler operations use the existing embedded syscall request/result
contract and an exact sorted `args.scheduleFrontier` of accepted event hashes.
Lifecycle membership changes append receipts; a committed scheduler result
compacts the frontier to its own hash. The input limit is 4096 outstanding
receipts; larger uncheckpointed frontiers fail closed (compaction/scale policy
beyond that bound is not implemented). References are explicit topological
edges; stale/missing frontiers cannot commit results. The scheduler state,
frontier and quotas are included in the kernel digest and speculative clone.
The command adapter supplies the frontier and reports the scheduler view.
Control-plane syscalls remain independent of CPU-turn accounting; this is
not an instruction executor or preemptive scheduler. Cooperation is required
for liveness. Late conflicting histories may invalidate unfinalized receipts.
The ordinary room root is not a distributed scheduler/finality authority.

## Content-addressed memory (#279)

Three distinct contracts:

- **Identity:** SHA-256 of exact bytes, at most 64 KiB per object in this slice.
- **History:** `qos.event/1` holds descriptors, handles and graph mutations,
  never payload bytes. Replayed metadata is a claim, not a byte-possession
  proof. `mem_put` declares a descriptor through the caller root; same content ID
  and size deduplicate, conflicting lengths fail closed. `mem_get` and
  `mem_stat` return metadata; byte retrieval is a separate availability API.
  `mem_ref` attenuates an existing handle and `mem_drop` closes it.
  `mem_link` / `mem_unlink` use a WRITE source handle and READ destination
  handle in the caller namespace, with process-scoped edge ownership.
- **Availability:** `QosMemoryBytes.prepare` hashes a detached byte snapshot,
  optionally publishes explicitly to a configured `RholoRegistryMemory`,
  requires verified readback, then caches and returns descriptor metadata.
  `get` takes a current kernel callback plus caller PID and handle; it verifies
  length/hash on both local and remote paths, rechecks authorization after I/O,
  and never reconstructs bytes from a hash. OPFS and room-memory caches are
  scoped adapters; `scripts/qos-cli/memory-byte-cache.mjs` is a filesystem
  adapter for memory carriers (daemon message wiring remains open).

Memory requests use exact sorted `memoryFrontier` (maximum 4096 receipts),
plus handle-version references for both handles when linking. Successful
mutations compact the frontier; other kernel transitions that change the
live root set add receipts. Replay checks versions before request and
result, commits only matching outcomes, and hashes graph state and roots.
Independent concurrent mutations may invalidate speculative receipts:
the conservative frontier is not a distributed conflict-resolution protocol.

Reachability is an iterative mark traversal from all locally known live,
unrevoked memory handles. Cycles are safe; orphan cycles are logically
unreachable. Dropping one handle cannot collect an object reachable through
another known handle or edge. Edges and descriptors remain in journal history
after dereferencing. Local GC removes only known unreachable cached bytes,
honors staging and caller-supplied pins, does not issue durable deletes, and
does not infer global unreachability. Unknown cache entries are retained.
Collector/read operations are serialized per service; multiple services/tabs
need external coordination and fresh local snapshots. Cache loss and GC do
not change the canonical digest.

The registry adapter uses immutable insertArbitrary, signed deploy verdict
and hash-verified lookup; no automatic deployment. The stored wire value
is a quoted ASCII literal `qos.memory/1:<sha256>:<lowercase hex>`, avoiding
escaped quotes unsupported by the bundled Rholo parser. Readback rehashes
decoded bytes; legacy JSON records are accepted only after the same checks. Browser SDK and disk
adapter are exposed, not automatically wired into the daemon or application
UI. Registry readback against a real disposable Rholo node and multi-peer
offline availability remain integration gates; the dedicated CI fixture
uses an independent in-memory durable backend, not a live chain. Content IDs
and journal locators are public room metadata, not confidentiality or proof
of possession. The API enforces handle ownership, not secrecy of content
published to a public registry.

## Security invariants

1. A handle never outlives its process.
2. Kernel-handle revocation invalidates descendants; a revoked handle returns `EACCES`.
   Preserve allocation lineage even when an intermediate handle is closed or a
   process is reaped; closing a handle is not a revocation boundary. A spawned
   root inherits the image handle's lineage. The lineage ledger is part of the
   replay digest and speculative clone. Compaction is not yet implemented.
   Distributed proxy revocation for already-disclosed bearer capabilities is a separate
   mechanism ([#107](https://github.com/rhovision-org/quantum-os/issues/107)).
3. Closing a handle returns it to `EBADF`; it is not silently reissued with old rights.
4. A process cannot signal a target without a `SIGNAL` handle to `proc:<pid>`.
5. `spawn` requires `EXEC` on the image handle; the child never inherits a broader set.
6. No operation takes a raw object id where a handle is required.
7. Kernel introspection (`list`, `getProcess`) is a test/bootstrap affordance in v0;
   the room-facing version must be capability-gated.

## Mapping to today's code

| ABI concept | Current code |
|---|---|
| Process / PID | `qos-process.ts` `processIdFor`, `QosProcessView` |
| dyncap-attributed events | `QosEventSigner`, `QosEventLog`, `QosProcessRoom` |
| Authority | `zfa.ts` / `crates/zfa-core`, `dyncap.ts` |
| Room transport | `QOSPeer` (`peer.ts` / `qospeer.mjs`) |
| Sockets | `posix-net.ts` |
| Durable bytes | rholo deploy/Channel (primary); `library.ts` OPFS helpers, `record.ts` (local cache) |
| Room memory | `room-memory.mjs`, `qos-daemon.mjs` |
| Shell | `app.ts` `handleCommand`, `/script`, `/macro`, `/rhoqu` |
| Kernel v0 | `qos-kernel.ts` (this ABI) |

## Versioning

`QOS_ABI_VERSION = 0` for this model. A breaking change to object semantics, a syscall's
arguments, or the error set bumps the version and updates this page in the same PR.
Adding a reserved syscall implementation does not bump it.
