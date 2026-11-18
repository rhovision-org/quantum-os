# QOS/1 — QuantumOS as an operating system

**Status:** design + first vertical slice. The kernel ABI v0 is being implemented in
[#277](https://github.com/rhovision-org/quantum-os/issues/277); the other layers below
are design, tracked as issues. This page is the map, not a claim that every layer runs.

QuantumOS already has most of an OS's hard parts, but they grew as separate features.
The QOS/1 programme gives them one kernel contract without turning the room into a
client/server system.

## The machine model

| OS concept | QuantumOS realization |
|---|---|
| Machine | a room, identified by `cap:room:…` |
| Boot medium | the room capability token itself |
| CPU / node | a browser tab or a headless `QOSPeer` |
| Kernel journal | the signed `qos.event/1` log |
| Process | a named, capability-guarded continuation (`qos-process.ts`) |
| PID | the `qos:proc:…` process id |
| Identity / UID | a dyncap anchor (`cap:peer/dyn:…`) |
| Authority | ZFA capabilities and dyncap-signed envelopes |
| File descriptor | a capability handle in the kernel handle table |
| IPC | room chat, `qos-event`, `/channel`, POSIX-style sockets |
| Persistent store | OPFS + room memory + `qos-daemon.mjs` |
| Shell | slash commands, `/script`, `/macro`, `/rhoqu`, `/ask`, `/qos` |
| Driver | a browser or Node host capability behind a device handle |
| Shutdown | leave the room |

The room is the machine. There is no privileged kernel server; every peer enforces the
same rules over the same signed log. Joining is boot; leaving is shutdown; the
capability is the boot image.

## Invariants

1. **No ambient authority.** Every operation names a process and a handle. There is no root.
2. **Determinism.** Same signed event log + same policy ⇒ same state digest on every peer.
3. **No privileged server.** Signaling routes handshakes only; it never schedules or judges.
4. **Capabilities are the ABI.** A file, process, device, or service is reachable only
   through a handle that carries the needed rights.
5. **Off-chain by default.** A chain anchor is optional; boot, processes, VFS, and
   services work with no chain RPC.
6. **Attribution, not trust.** Events carry their source and dyncap proof; trust is a
   governance decision layered above the kernel.
7. **No wall clock.** Ordering is event/sequence based. `sleep` and quotas use logical time.

## Architecture

```text
┌────────────────────────────── room (machine) ──────────────────────────────┐
│  shell: /sh · /ps · /kill · /jobs · pipes · redirection · env              │
│  applications: /poll · /lemma · /note · /gov · /qos · agents · bridge      │
│  services: init · facilitator · scribe · memory daemon · package manager   │
├────────────────────────────────────────────────────────────────────────────┤
│  syscall ABI: qos.syscall/1 (planned wire form; v0 is a pure TS model)     │
├────────────────────────────────────────────────────────────────────────────┤
│  kernel: process table · handle table · scheduler · signals · VFS · devices │
├────────────────────────────────────────────────────────────────────────────┤
│  memory: content-addressed objects · room memory · OPFS · snapshots        │
├────────────────────────────────────────────────────────────────────────────┤
│  transport: QOSPeer / WebRTC · posix-net sockets · signaling handshakes    │
└────────────────────────────────────────────────────────────────────────────┘
```

## Layers and status

| # | Layer | Status | Issue |
|---|---|---|---|
| 0 | Machine, boot, identity, transport | **done** — room cap, `QOSPeer`, dyncap, ZFA, `posix-net` | — |
| 1 | Kernel ABI: handles, syscalls, process table | **v0 model** — handles, rights, signals, wait/exit; room wiring next | [#277](https://github.com/rhovision-org/quantum-os/issues/277) |
| 2 | Deterministic scheduler and signals | design | [#278](https://github.com/rhovision-org/quantum-os/issues/278) |
| 3 | Content-addressed memory and GC | design | [#279](https://github.com/rhovision-org/quantum-os/issues/279) |
| 4 | Virtual filesystem and `/fs` | design | [#280](https://github.com/rhovision-org/quantum-os/issues/280) |
| 5 | Shell: spawn/exec/wait, pipes, env | partial — commands, `/script`, `/ps`; no pipelines/jobs | [#281](https://github.com/rhovision-org/quantum-os/issues/281) |
| 6 | Users, groups, capability permissions | partial — dyncap/ZFA/groups; no unified rights | [#282](https://github.com/rhovision-org/quantum-os/issues/282) |
| 7 | Device model and drivers | partial — media/OPFS/WASM/rholang/sockets; no device ABI | [#283](https://github.com/rhovision-org/quantum-os/issues/283) |
| 8 | Init, services, package manager | partial — agents, daemon, bridge; no init/pkg | [#284](https://github.com/rhovision-org/quantum-os/issues/284) |
| 9 | Observability, snapshots, recovery | partial — `/qos status`, `/ps`, logs; no `/top`/trace/restore | [#285](https://github.com/rhovision-org/quantum-os/issues/285) |
| 10 | Native runtime and boot image | design | [#286](https://github.com/rhovision-org/quantum-os/issues/286) |

## What exists today

- **Processes:** `qos.event/1` (finite schema), `QosEventSigner`, `QosEventLog`,
  `QosProcessRoom`, and `/qos start|status|ps|suspend|resume|terminate|kill` plus
  the `/ps` and `/kill` aliases.
- **Authority:** ZFA validation on every event, dyncap chain verification, capability
  attenuation in `qos-process.ts`, owner-only lifecycle transitions.
- **Transport:** `QOSPeer` with sealed frames, hashed room ids, relay overlay, keepalive;
  POSIX-style stream/dgram sockets in `posix-net.ts`.
- **Persistence:** OPFS-backed library/record storage; `qos-daemon.mjs` and
  `agent.mjs --persist` hold and re-serve room memory.
- **Services:** facilitator, scribe, skeptic, greeter, observer, bridge, memory daemon.
- **Shell:** slash commands, `/script` sequencing, `/macro` definitions, `/rhoqu` macros,
  `/ask` agent routing.

## Milestones

### M0 — one contract (kernel ABI v0) — **v0 implemented**

`qos-kernel.ts` and `docs/os-abi.md` deliver the process/handle table, rights
attenuation, close/revoke, signals, wait/exit, error values, and a deterministic
state digest (42 tests). No UI wiring is required; this is the seam everything
else builds on. Room-facing wiring is the next slice.

### M1 — process table in the room — **first slice implemented**

The existing `/qos` surface now exposes a table with stable PIDs, owner labels,
state, event count, and digest, plus `/qos ps`, `/ps`, `/qos kill`, and `/kill`
(owner-only). A bounded lifecycle trace and the kernel-backed table are next.

### M2 — storage

Content-addressed memory + GC, then a capability-rooted VFS with `/fs`. Files are
objects; directories are manifests; mounts are capability roots. OPFS persists bytes.

### M3 — shell and users

`/sh` with pipes, redirection, environment, and jobs. Identity already exists; add
rights-based `whoami`/`id`/`chmod`/`chown` semantics, group-owned objects, and revocation.

### M4 — devices and services

Wrap WebRTC, media, OPFS, WASM/ZFA, rholang, and sockets as devices behind handles.
Add `init`, service dependencies/restart, and a signed package manifest for agents,
macros, and contracts.

### M5 — operations and native boot

`/top`, `/dmesg`, `/trace`, snapshots/restore, quotas. Then a `qos.boot/1` image and a
Node/WASM runtime that reaches the same digest as a browser peer.

## Definition of done for QOS/1

A new peer can boot from a room capability and, without any additional server:

1. see a process table and system services;
2. spawn, signal, wait for, and reap a process;
3. open, read, write, and close a file through a capability handle;
4. run a pipeline in the shell with redirection;
5. be denied an operation it lacks a capability for;
6. replay the same signed event log on another peer and reach the same digest;
7. inspect a kernel trace and restore a snapshot;
8. do all of that with no chain RPC.

## Non-goals

- Replacing Linux or running arbitrary native binaries in the browser.
- A trusted central scheduler or server-side kernel.
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


For the group charter handoff identity and wallet-signature trust boundary, see [Success-charter identity boundary](success-charter-identity-boundary.md).
