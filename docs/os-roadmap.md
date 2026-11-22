# QOS/1 — QuantumOS as an operating system

**Status:** design + first vertical slice. Kernel ABI v0 is implemented in
[#277](https://github.com/rhovision-org/quantum-os/issues/277); the canonical journal and
room wiring are the next slice in
[#317](https://github.com/rhovision-org/quantum-os/issues/317); the other layers below are
design, tracked as issues. This page is the map, not a claim that every layer runs.

QuantumOS already has most of an OS's hard parts, but they grew as separate features.
The QOS/1 programme gives them one kernel contract without turning the room into a
client/server system.

## The machine model

| OS concept | QuantumOS realization |
|---|---|
| Machine | a room, identified by `cap:room:…` |
| Boot | room capability = bootstrap authority; `qos.boot/1` manifest = public boot image |
| CPU / node | a browser tab or a headless `QOSPeer` |
| Kernel journal | the canonical dyncap-attributed `qos.event/1` log |
| Process | a named, capability-guarded continuation (`qos-process.ts`) |
| PID | the `qos:proc:…` process id |
| Identity / UID | a dyncap anchor (`cap:peer/dyn:…`) |
| Authority | ZFA capabilities and dyncap-attributed envelopes |
| File descriptor | a capability handle in the kernel handle table |
| IPC | room chat, `qos-event`, `/channel`, POSIX-style sockets |
| Persistent store | rholo (durable) + OPFS/room memory (local cache) + `qos-daemon.mjs` |
| Shell | slash commands, `/script`, `/macro`, `/rhoqu`, `/ask`, `/qos` |
| Driver | a browser or Node host capability behind a device handle |
| Shutdown | leave the room |

The room is the machine. There is no privileged kernel server; every peer enforces the
same rules over the same dyncap-attributed log. Joining is boot; leaving is shutdown.

The journal is the single mathematical seam. `qos.syscall/1` names syscall
request/result payloads; it is **not** a second journal. Syscall requests, results,
refusals, lifecycle transitions, and external observations all enter as finite
`qos.event/1` event types.

## Invariants

1. **No ambient authority.** Every operation names a process and a handle. There is no root.
2. **Determinism.** Same set of valid events + same policy ⇒ same ordered journal and state
   digest, regardless of network arrival order. Causal dependencies order first; otherwise-
   concurrent events order by `(source anchor, seq, hash)`. No wall-clock tie-break.
3. **No privileged server.** Signaling routes handshakes only; it never schedules or judges.
4. **Capabilities are the ABI.** A file, process, device, or service is reachable only
   through a handle that carries the needed rights.
5. **Local-first, rholo-durable.** Boot, processes, cached VFS reads, and services work with
   no chain RPC; durable storage is written to rholo explicitly. A chain anchor is not a
   precondition for local operation.
6. **Attribution, not trust.** Events carry their source and dyncap attribution
   (TOFU-pinned, hash-chained continuity), not a cryptographic signature; trust is a
   governance decision layered above the kernel.
7. **No wall clock.** Ordering is event/sequence based. `sleep` and quotas use logical time.

## Architecture

```text
┌────────────────────────────── room (machine) ──────────────────────────────┐
│  shell: /sh · /ps · /kill · /jobs · pipes · redirection · env              │
│  applications: /poll · /lemma · /note · /gov · /qos · agents · bridge      │
│  services: init · facilitator · scribe · memory daemon · package manager   │
├────────────────────────────────────────────────────────────────────────────┤
│  syscall ABI: qos.syscall/1 payloads inside qos.event/1 (planned; v0 TS)  │
├────────────────────────────────────────────────────────────────────────────┤
│  kernel: process table · handle table · scheduler · signals · VFS · devices │
├────────────────────────────────────────────────────────────────────────────┤
│  memory: content-addressed objects (rholo) · OPFS cache · snapshots        │
├────────────────────────────────────────────────────────────────────────────┤
│  transport: QOSPeer / WebRTC · posix-net sockets · signaling handshakes    │
└────────────────────────────────────────────────────────────────────────────┘
```

## Layers and status

| # | Layer | Status | Issue |
|---|---|---|---|
| 0 | Machine, boot, identity, transport | **done** — room cap, `QOSPeer`, dyncap, ZFA, `posix-net` | — |
| 1 | Kernel ABI: handles, syscalls, process table | **v0 model** — handles, rights, signals, wait/exit; room wiring in #317 | [#277](https://github.com/rhovision-org/quantum-os/issues/277) |
| 1a | Kernel journal and room wiring | design — one `qos.event/1` journal, canonical order, `/qos` replay | [#317](https://github.com/rhovision-org/quantum-os/issues/317) |
| 2 | Deterministic scheduler and signals | design — depends on 1a canonical order | [#278](https://github.com/rhovision-org/quantum-os/issues/278) |
| 3 | Content-addressed memory and GC | design — identity, journal state, rholo availability, local-cache GC | [#279](https://github.com/rhovision-org/quantum-os/issues/279) |
| 4 | Virtual filesystem and `/fs` | design — COW versioned root, mounts over rholo/cache | [#280](https://github.com/rhovision-org/quantum-os/issues/280) |
| 5 | Shell: spawn/exec/wait, pipes, env | partial — commands, `/script`, `/ps`; no pipelines/jobs | [#281](https://github.com/rhovision-org/quantum-os/issues/281) |
| 6 | Users, groups, capability permissions | partial — dyncap/ZFA/groups; kernel vs proxy revocation (#103/#107) | [#282](https://github.com/rhovision-org/quantum-os/issues/282) |
| 7 | Device model and drivers | partial — media/OPFS/WASM/rholang/sockets; no device ABI; observations not yet modeled | [#283](https://github.com/rhovision-org/quantum-os/issues/283) |
| 7a | Result backends: rholo primary, QPU secondary | design — primary: `/solve --anchor` on rholo; secondary: `/solve --qpu` and `/qpu` execution | [#316](https://github.com/rhovision-org/quantum-os/issues/316) |
| 8 | Init, services, package manager | partial — agents, daemon, bridge; no init/pkg | [#284](https://github.com/rhovision-org/quantum-os/issues/284) |
| 9 | Observability, snapshots, recovery | partial — `/qos status`, `/ps`, logs; no `/top`/trace/restore | [#285](https://github.com/rhovision-org/quantum-os/issues/285) |
| 10 | Native runtime and boot manifest | design — public `qos.boot/1`; room cap is bootstrap authority | [#286](https://github.com/rhovision-org/quantum-os/issues/286) |

## What exists today

- **Processes:** `qos.event/1` (finite schema), `QosEventSigner` (dyncap attribution),
  `QosEventLog`, `QosProcessRoom`, and `/qos start|status|ps|suspend|resume|terminate|kill`
  plus the `/ps` and `/kill` aliases.
- **Journal:** `qos.event/1` is the only canonical stream; `qos.syscall/1` is a payload
  shape inside it, not a second journal. `/qos` still reads `QosProcessRoom`, not kernel
  replay ([#317](https://github.com/rhovision-org/quantum-os/issues/317)).
- **Authority:** ZFA validation on every event, dyncap chain verification, capability
  attenuation in `qos-process.ts`, owner-only lifecycle transitions.
- **Transport:** `QOSPeer` with sealed frames, hashed room ids, relay overlay, keepalive;
  POSIX-style stream/dgram sockets in `posix-net.ts`.
- **Local cache:** OPFS-backed library/record storage; `qos-daemon.mjs` and
  `agent.mjs --persist` hold and re-serve room memory. The rholo backend below is the
  durable store.
- **Rholo backend (primary):** `/rholang deploy` writes a deploy's answer to the key's
  signed registry slot, and `/channel chain` keeps durable on-chain records. M6's
  `/solve --anchor` persists the logical result here first, with no QPU required.
- **Services:** facilitator, scribe, skeptic, greeter, observer, bridge, memory daemon.
- **Shell:** slash commands, `/script` sequencing, `/macro` definitions, `/rhoqu` macros,
  `/ask` agent routing.
- **Quantum surface:** `/braket`, `/qucalc`, `/search`, and `/solve` evaluate bra-ket states,
  twist histories, next closures, and the chosen closure locally in the peer. The QPU is the
  secondary execution backend; there is no `/solve --qpu` or `/qpu` driver yet (see M6 /
  [#316](https://github.com/rhovision-org/quantum-os/issues/316)).

## Milestones

### M0 — one contract (kernel ABI v0) — **v0 implemented**

`qos-kernel.ts` and `docs/os-abi.md` deliver the process/handle table, rights
attenuation, close/revoke, signals, wait/exit, error values, and a deterministic
state digest (42 tests). No UI wiring is required; this is the seam everything
else builds on. Room-facing wiring is the next slice.

### M1 — process table in the room — **first slice implemented**

The existing `/qos` surface now exposes a table with stable PIDs, owner labels,
state, event count, and digest, plus `/qos ps`, `/ps`, `/qos kill`, and `/kill`
(owner-only). Kernel-backed table and canonical replay land in M1a.

### M1a — kernel journal and room wiring — **next**

`qos.event/1` is the sole canonical journal. Syscall requests, results, refusals, lifecycle
transitions, and external observations enter as finite event types; `qos.syscall/1` is the
payload shape inside them, not a second journal. Causal dependencies order first; otherwise-
concurrent events order by `(source anchor, seq, hash)`. `/qos` and `/ps` derive from kernel
replay, not a parallel `QosProcessRoom` model. Ship a deterministic trace/replay harness with
this slice — it is the instrument #278–#284 use to prove ordering. Dyncap provenance is
TOFU/chained attribution, not a cryptographic signature. Tracked in
[#317](https://github.com/rhovision-org/quantum-os/issues/317).

### M2 — storage: identity, history, availability

**Storage is on rholo.** Three things stay separate: **SHA-256 determines object identity**;
**the journal determines machine state/history**; **rholo provides durable object
availability**, with OPFS and room memory as local cached availability. The object graph/state
is deterministically rebuildable from the journal; the bytes themselves require rholo or cache
— a hash alone does not reconstruct them.

GC is **local-cache GC plus logical dereferencing of durable objects**. A peer cannot prove
global unreachability while another peer may be offline holding a reference, and immutable
rholo records are not physically collected. Do not claim distributed physical GC.

`/fs` is the capability-rooted namespace over those objects, not an alternative store: files
are objects, directories are manifests, mounts are capability roots. Namespace writes are
copy-on-write: immutable objects + immutable directory manifests + a versioned root; an
operation consumes a base root hash and produces a new root. Concurrent operations are ordered
by the canonical journal or preserved as an explicit conflict, never resolved by arrival
timing. See [#279](https://github.com/rhovision-org/quantum-os/issues/279) and
[#280](https://github.com/rhovision-org/quantum-os/issues/280).

### M3 — shell and users

`/sh` with pipes, redirection, environment, and jobs. Identity already exists; add
rights-based `whoami`/`id`/`chmod`/`chown` semantics and group-owned objects. Distinguish
**kernel-handle revocation** (local handle table and descendants) from **distributed proxy
revocation** for already-disclosed bearer capabilities ([#107](https://github.com/rhovision-org/quantum-os/issues/107)).
Integrate the [#103](https://github.com/rhovision-org/quantum-os/issues/103) group
identity/quorum envelope before treating a group as a UID.

### M4 — devices and services

Wrap WebRTC, media, OPFS, WASM/ZFA, rholang, and sockets as devices behind handles. External
resources are **observation-producing nondeterministic boundaries**: the kernel emits a
request event, the driver emits an observation event, and replay consumes the recorded
observation without contacting the device. Driver failure is an errno/event, not a local-only
error. Add `init`, service dependencies/restart, and a dyncap-attributed package manifest for
agents, macros, and contracts.

### M5 — operations and native boot

Trace/replay landed with M1a. M5 adds `/top`, `/dmesg`, quotas, and snapshots. A restore
replays to the snapshot and **forks a new continuation**; the original journal remains
append-only, so rollback never erases events other peers already observed. Then a public
content-addressed `qos.boot/1` manifest (kernel version, init manifest, package set, device
bindings) and a Node/WASM runtime that reaches the same digest as a browser peer. The room
capability is **bootstrap authority**, not the boot image; peers discover the current manifest
by its content address/anchor.

### M6 — result backends: rholo primary, QPU secondary — **design** · [M6 milestone](https://github.com/rhovision-org/quantum-os/milestone/1)

Rholo is the primary result backend (Layer 7a): `/solve --anchor` canonicalizes the logical
result and persists it through the existing signed-deploy path, with no QPU required. The QPU
is the secondary execution backend: `/solve --qpu` optionally runs the chosen closure through
QLF's Rho→circuit transpilation on a real vendor API, and its observation attaches to the same
canonical record. `/solve` without flags stays local and deterministic; hardware is opt-in, and
the vendor key is a capability, never ambient authority. A deterministic mock QPU backend lands
first, then one live adapter (IBM Quantum/Qiskit Runtime, Amazon Braket, or Azure Quantum).
Tracked in [#316](https://github.com/rhovision-org/quantum-os/issues/316).

QPU results enter the journal as **recorded observation events**: replay consumes those bytes
and never calls the vendor. Calibration timestamps are opaque observation fields, not kernel
time; the scheduler still uses logical time only.

Command surface, with no separate `/qsolve`: `/solve --anchor` is the primary rholo path and
works without `--qpu`; `/solve --qpu <handle> [--shots N] [--no-wait] [--dry-run] [--anchor]`
adds the secondary QPU run. `/qpu list|probe|status|result|cancel|anchor` handles device/job
lifecycle; `/qpu anchor` reuses the primary record path. `--anchor` is accepted with or without
`--qpu`; `--shots`, `--no-wait`, and `--dry-run` require `--qpu`. `--all` stays local and cannot
combine with `--qpu`; `/search` stays local. The chain verb is `anchor`, not `persist` —
`/persist` already means peer replication.

The QOS→rholo event bridge is automatic — `qos.event/1` is the same JSON a rholo/rholalc
consumer ingests, with no translation layer. Anchoring a result to rholo is a **requirement**,
but it is one explicit command, not an out-of-band deploy: `/solve --anchor` (and
`/solve --qpu … --anchor` or `/qpu anchor <job>` for a hardware observation) canonicalizes the
result, deploys it through the existing `deployTerm`/`deployVerdict` path (an `insertArbitrary`
result URI or a chain Channel post), waits for the block, and then emits the capability-authorized
`anchor` event with `{chain, deployId, blockHash?, recordHash}`. Room-local state stays cheap;
the chain write is user-triggered because it costs phlo and is permanent. No job completion
writes to chain automatically (see [`qos-process.md`](qos-process.md) for the `anchor` contract).

Repo references: [`docs/commands.md`](commands.md) (`/braket`, `/qucalc`, `/solve`),
[`packages/browser/src/app.ts`](../packages/browser/src/app.ts),
[`rholang.ts`](../packages/browser/src/rholang.ts) (`deployTerm`/`deployVerdict`, chain Channel writes),
[`qucalc-enum.ts`](../packages/browser/src/qucalc-enum.ts),
[`qucalc-search.ts`](../packages/browser/src/qucalc-search.ts),
[`RhoQuCalc_Macros.md`](../RhoQuCalc_Macros.md), and [`RhoQuDemo.md`](../RhoQuDemo.md).

QLF references: [`QuantumOS.md` §1a](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QuantumOS.md)
(control plane for real quantum hardware),
[`quantum-computation-optimization.md` §3.5/§5](https://github.com/rhovision-org/quantum-logical-framework/blob/main/quantum-computation-optimization.md)
(the Rho→gate-pulse bridge is open work),
[`quantum_simulator.py`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/quantum_simulator.py),
[`qucalc_engine.py`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/qucalc_engine.py),
[`rho_transpiler.py`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/rho_transpiler.py), and
[`braket_rho.py`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/braket_rho.py);
semantics in [`BraKetRhoQuCalc.md`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/BraKetRhoQuCalc.md)
and Lean [`BraKetRhoQuCalc.lean`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean) /
[`RhoQuCalc.lean`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean).

## Definition of done for QOS/1

A new peer can boot from a room capability and, without any additional server:

1. see a process table and system services;
2. spawn, signal, wait for, and reap a process;
3. open, read, write, and close a file through a capability handle;
4. run a pipeline in the shell with redirection;
5. be denied an operation it lacks a capability for;
6. replay the same event set in any arrival order and reach the same ordered journal and
   digest;
7. inspect a kernel trace and restore a snapshot by replaying and forking, leaving the
   original journal append-only;
8. do all of that from the local cache with no chain RPC; durable writes to rholo are
   explicit deploys.

## Non-goals

- Replacing Linux or running arbitrary native binaries in the browser.
- A trusted central scheduler or server-side kernel.
- A second `qos.syscall/1` journal or a translation layer between room and kernel events.
- Cryptographic signatures on the kernel journal; dyncap is TOFU/chained attribution.
- Distributed physical garbage collection; GC is local-cache plus logical dereference.
- Byzantine consensus/finality beyond the existing `/qos` and `/probe` contracts.
- A physical clock or real-time guarantees.
- Chain finality as a precondition for local operation.
- POSIX compatibility for its own sake; capability semantics win where they conflict.

## Contributing

Pick an issue, read [`os-abi.md`](os-abi.md) first, and keep the layer boundary clean:
a kernel module must not import DOM, storage, network, or `app.ts`. Add a deterministic
test with two independent instances whenever state is involved. The review checklist is
in [`CLAUDE.md`](../CLAUDE.md#documentation-prs).

## Related

- [Architecture](architecture.md) — the contracts that run today.
- [QOS processes](qos-process.md) — the finite `qos.event/1` contract.
- [Connection](connection.md) — transport, overlay, TURN, reconnect.
- [Commands](commands.md) — the shell surface as it exists today.
- [Security](../SECURITY.md) — ZFA/dyncap threat model.
- [QLF QuantumOS](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QuantumOS.md) — QLF as the kernel for real quantum hardware.
- [QLF quantum-computation-optimization](https://github.com/rhovision-org/quantum-logical-framework/blob/main/quantum-computation-optimization.md) — the Rho→gate-pulse bridge tracked in M6.
