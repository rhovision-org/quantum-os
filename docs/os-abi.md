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
| `state` | `running` · `suspended` · `exited` · `reaped` |
| `exitCode` | set on exit; negative signal number for a signal kill |
| `root` | handle id of the process's namespace root |
| `handles` | live handle ids |

### Suspend / resume (ABI v0 model)

The kernel model supports explicit `suspend(caller, target)` and `resume(caller, target)` transitions. Both require a live capability handle whose object is `proc:<target>` and whose rights include `SIGNAL`; self-suspend/self-resume is rejected (`EINVAL`). Suspend is valid only from `running`, resume only from `suspended`. These are deterministic state transitions, not scheduler preemption: the model does not yet implement CPU scheduling or execution queues. A suspended process is not a valid syscall caller; caller-side kernel operations fail with `ENOENT`. A suspended child remains active, so `wait` returns `EAGAIN`. Terminating signals may target a suspended process and move it to `exited`.

| Transition | Preconditions | Result |
|---|---|---|
| `running → suspended` | caller running, target running, non-self, target `SIGNAL` handle | `ok(true)` |
| `suspended → running` | caller running, target suspended, non-self, target `SIGNAL` handle | `ok(true)` |
| repeated suspend / invalid resume | state precondition not met | `EINVAL` |
| missing process-control capability | no live target `SIGNAL` handle | `EACCES` |
| suspended child wait | direct child is suspended (not exited) | `EAGAIN` |

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
| `read` | `handle` | bytes/text | reserved — memory #279 |
| `write` | `handle`, `data` | bytes written | reserved — memory #279 |
| `stat` | `handle` | object metadata | reserved — VFS #280 |
| `mkdir` / `unlink` / `rename` | path/handle args | — | reserved — VFS #280 |
| `mount` / `unmount` | handle/path | — | reserved — VFS #280 |
| `send` / `recv` | `handle`, bytes | — | reserved — IPC #281 |
| `listen` / `connect` / `accept` | address | handle | reserved — `posix-net` adapter #283 |
| `svc_register` / `svc_lookup` | name, handle | — / handle | reserved — init #284 |
| `yield` / `sleep` | — / logical ticks | — | reserved — scheduler #278 |
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
- No ambient randomness. PIDs and handle ids are monotonically allocated.
- Process iteration is sorted by `pid`; handle iteration by `handle id`.
- `stateDigest()` canonicalizes the process/handle table (sorted keys, sorted arrays)
  and hashes it with SHA-256.
- Journal order is causal first (`prev`, grants, object versions, process creation);
  otherwise-concurrent events order by `(source anchor, seq, hash)`. Arrival order is not an
  input.
- A replay is the same ordered operation sequence; two kernels that receive it must
  produce the same `stateDigest()`.

## Planned syscall event payload

This is the payload shape carried inside a `qos.event/1` event; v0 does not emit it.
`qos.syscall/1` never forms a parallel journal.

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
    "op": "open",
    "handle": "h:3",
    "args": { "object": "file:notes/plan.md", "rights": 3 },
    "nonce": "…"
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
error, so every peer can audit and replay it.

## Security invariants

1. A handle never outlives its process.
2. Kernel-handle revocation invalidates descendants; a revoked handle returns `EACCES`.
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
