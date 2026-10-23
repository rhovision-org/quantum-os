# Architecture — what runs where, and the contracts between the pieces

The systems-engineering parent document (quantum-os#116): the monorepo layout, the
security model as the code enforces it, the browser peer API, the Rust kernel, the
signaling wire protocol, and the WASM boundary. Everything here is **executable today**;
designs that are not are listed under *Roadmap* in the [README](../README.md#roadmap--what-is-design-not-code).
Detail pages hang off this one:

| Page | Covers |
|---|---|
| [connection.md](connection.md) | signaling trust model, room capacity, the bounded-degree overlay, leased peer ids, `/ice`, the default TURN relay, reconnect fixes |
| [rholang.md](rholang.md) | the `$`/`+` macro language, the `%` capability-macro registry, the `/rholang` chain client |
| [commands.md](commands.md) | every slash command |
| [../Consensus.md](../Consensus.md) | the `/probe` protocol and threat model |
| [../SECURITY.md](../SECURITY.md) | the full threat model, known issues, reporting |
| [../scripts/qos-cli/README.md](../scripts/qos-cli/README.md) | the headless Node peer, memory daemon, agents, bridge |
| [../CLAUDE.md](../CLAUDE.md) | per-feature module map (`app.ts` + `notes.ts` + …) and the development workflow |

---

## Repository layout

```
crates/
  zfa-core/          Rust — ZFA kernel
                     → compiles to WASM (browser) and native binary (server)

packages/
  zfa-core-wasm/     wasm-pack output (build artifact, not committed)
  signaling/         TypeScript — WebSocket signaling server (port 4444)
  browser/           TypeScript — WebRTC peer, loads ZFA WASM

scripts/
  qos-cli/           Node — headless room peer: one-shot CLI + persistent
                     memory-peer daemon. Standalone (outside the workspace).
```

**Monorepo:** Cargo workspace + pnpm workspace.

---

## ZFA security model

See [SECURITY.md](../SECURITY.md) for the full threat model, known issues, and vulnerability reporting policy.

The 8-twist alphabet `{^, v, <, >, /, \, +, -}` encodes all processes. A history achieves **ZFA** when it is a **half-spin closure** — a process whose execution returns a spin-1/2 spinor to itself up to a global phase. `achieves_zfa` is the conjunction of the two algebraic faces of that closure (enforced uniformly in Rust, WASM, TypeScript, and the QLF Python core since v0.17):

1. **Pauli closure** (non-abelian face) — the ordered matrix product of twists lands in `{+I, −I, +iI, −iI}` (the Pauli scalar group). Each twist maps to an SU(2) generator (`^v` ↔ ±σ_y, `<>` ↔ ∓σ_x, `/\` ↔ ±σ_z, `+-` ↔ ±I); order matters because Paulis anti-commute. **This IS the SU(2)-scalar-return reading of half-spin closure** — the spinor closes up to phase.
2. **Count balance** (abelian face) — `count_pos = count_neg` (spectral gap = 0). The Hermitian-pair multiset count: each twist paired with its conjugate (bra-ket structure).

Pauli closure is not a "second condition" layered on top of count balance — it IS half-spin closure, read non-abelianly. Count balance is the same closure read as a Hermitian-pair multiset. Neither face implies the other in isolation; both together are the unique characterisation of a closed half-spin process. The 8-twist alphabet is the SU(2) generator set up to sign (SU(2) ≅ unit quaternions; Hurwitz singles out H as the unique non-commutative associative composition real algebra).

`Capability::from_entropy` uses rejection sampling so every issued token satisfies both faces by construction — unbalanced or Pauli-open tokens are algebraically impossible to construct, not merely rejected at runtime.

Key invariants (machine-verified in [QLF](https://github.com/rhovision-org/quantum-logical-framework)):
- `achieves_zfa` — half-spin closure (both algebraic faces: Pauli scalar return ∧ Hermitian-pair count balance)
- `spectral_gap = 0 ↔ is_symmetric` — eigenvalue-level stability
- `decoherence_impossibility` — parallel composition stays ZFA-balanced
- `no_magnetic_monopoles` — Gauss law from ZFA (∇·B = 0)

---

## Browser peer API (`@quantum-os/browser`)

```typescript
import { loadZfa, generateCapability, QOSPeer } from "@quantum-os/browser";

// Load ZFA WASM kernel
await loadZfa();

// Every room is identified by a ZFA capability token
const roomId = generateCapability("room");

const peer = new QOSPeer({
  signalingUrl: "ws://localhost:4444",
  roomId,
  onMessage: (from, data) => console.log(`[${from}]`, data),
  onPeerJoined: (id) => console.log("peer joined:", id),
  onPeerLeft:   (id) => console.log("peer left:",   id),
});

await peer.connect();

// Send to a specific peer or broadcast
peer.send(targetPeerId, { type: "hello" });
peer.broadcast({ type: "ping" });
```

---

## Rust ZFA core (`crates/zfa-core`)

```rust
use zfa_core::{achieves_zfa, spectral_gap, Capability};
use zfa_core::twist::Twist;

let h = vec![Twist::Up, Twist::Down, Twist::Plus, Twist::Minus];
assert!(achieves_zfa(&h));
assert_eq!(spectral_gap(&h), 0);

// Unforgeable ZFA-balanced capability token
let cap = Capability::root("kernel");
assert!(cap.is_valid());
assert_eq!(cap.spectral_gap(), 0);
```

---

## Signaling protocol

The signaling server is a thin WebSocket relay — it never sees data channel contents. Messages:

| Direction | Type | Purpose |
|---|---|---|
| client → server | `join` | Enter a room with a peer ID |
| server → client | `peers` | List of existing peers in the room |
| server → others | `joined` | Notify existing peers of new arrival |
| client → server | `offer` / `answer` / `ice` | WebRTC handshake relay |
| client → server | `leave` | Exit the room |
| server → others | `left` | Notify peers of departure |

Room IDs are ZFA capability tokens — knowing the room ID is the capability to join.

### Connection reliability

The signaling layer is designed to survive network interruptions without losing the room:

- **Server heartbeat** — the server pings every client every 25 seconds. Browsers respond automatically at the protocol level; connections that miss two consecutive pings are terminated cleanly. This keeps Fly.io's proxy from silently closing idle WebSocket connections.
- **Auto-reconnect** — if the signaling WebSocket drops, the client reconnects after 3 seconds (5 seconds on repeated failure) and re-joins the room. Existing peers detect the rejoin via the `joined` message and re-establish data channels via the normal offer/answer flow.
- **ICE failure detection** — `RTCPeerConnection.onconnectionstatechange` is monitored; a `"failed"` state triggers cleanup and notifies the app, so the peer list stays accurate rather than showing stale connected peers.
- **Free-tier server — hosted on Render (free tier); first connection after 15 min idle may take ~30s to wake. The heartbeat and auto-reconnect logic handles this transparently.

---

## Rust + WASM integration

The same `crates/zfa-core` crate compiles to:
- **WASM** (`--target web` via wasm-pack) — loaded by the browser peer
- **Native** (`cargo build`) — for server-side peers and CLI tools

WASM exports (via `wasm-bindgen`, enabled with `--features wasm`):

```typescript
wasm_achieves_zfa(twists: Uint8Array): boolean
wasm_is_pauli_closed(twists: Uint8Array): boolean
wasm_spectral_gap(twists: Uint8Array): number
wasm_div_b(twists: Uint8Array): number
wasm_charge(twists: Uint8Array): number
wasm_capability_from_entropy(bytes: Uint8Array, label: string): string
wasm_capability_valid(hex: string): boolean
```
