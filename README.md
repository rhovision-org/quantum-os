# quantum-os

> **QuantumOS (QOS) is an intelligent gateway to each other and everything.** It is the rho ZFA peer-to-peer layer — proven secure. Every identity, message, claim, and unit of value is a capability token whose validity is a machine-checked algebraic fact (Curry–Howard security, Lean-verified in [QLF](https://github.com/rhovision-org/quantum-logical-framework)), not a policy anyone has to trust or a server anyone has to ask. To an engineer that reads as *zero-trust p2p with capability tokens standing in for ACLs, sessions, and TLS all at once*. To anyone else it reads more simply: reaching another person and reaching the truth, the agreement, or the value between you are the same one verified act — the gateway to each other *is* the gateway to everything, because in QOS a relationship and a reality are the same kind of object.
>
> That security model runs **off-chain by default** — rooms, capability tokens, lemmas, notes, polls, rendezvous swaps, governance, and the file library are all verified peer-to-peer by the algebra itself, no consensus and no ledger required. That's not a limitation, it's the point: everyday activity leaves no public trace to correlate and costs nothing beyond the peers' own bandwidth. A blockchain (`/rholang`, the pooled token exchange, wrapped native tokens) is an opt-in extension reached for deliberately — a durable public record, a currency that must exist outside any one room — never a dependency of the security or privacy guarantee.
>
> It is also **quantum-secure where it counts**: capability tokens, dyncap identity, and the identity vault are built from CSPRNG entropy, SHA-256, and AES-256-GCM — no factoring or discrete-log keypair for Shor's algorithm to break, only the same brute-force search a quantum computer only quadratically speeds up (Grover). Only the opt-in chain path (`/rholang deploy`, secp256k1) carries the classical exposure every blockchain has today — see [SECURITY.md](SECURITY.md#quantum-security).

**Create reality together.** Two or more peers in a room share a ZFA process space — a combined `parallel(peer1, peer2, …)` that is provably ZFA-balanced by construction. The room is not a chat channel; it is a shared physical process where every identity is a capability token and every interaction is a verified quantum logical event.

Peer-to-peer QuantumOS running in the browser. ZFA kernel in Rust/WASM, WebRTC data channels for transport, self-hosted signaling server.

**[Open a room →](https://rhovision-org.github.io/quantum-os/)** · **[My room →](MyRoom.md)** · **[Syllogism Demo →](SyllogismDemo.md)** · **[Promissory Note Demo →](PromissoryNoteDemo.md)** · **[Atomic Swap Demo →](AtomicSwapDemo.md)** · **[Token Exchange Demo →](ExchangeDemo.md)** · **[Multisig Demo →](MultisigDemo.md)** · **[Dining Philosophers Demo →](DiningPhilosophersDemo.md)** · **[RhoQu Macro Demo →](RhoQuDemo.md)** · **[Optimization Demo →](OptimizationDemo.md)** · **[Consensus →](Consensus.md)** · **[EIES legacy →](EIES_Legacy.md)** · **[Security →](SECURITY.md)** · **[New issue →](https://github.com/rhovision-org/quantum-os/issues/new)**

**Group processes:** **[User Guide →](User_Guide.md)** · **[Developer Guide (build agents) →](Developer_Guide.md)** · **[MacRhoLang — write your own commands →](MacRhoLang.md)** · **[Group Decisions →](Group_Decisions.md)** · **[Quantum Problem Solver →](Collective_Optimization.md)** · **[Governance (liquid democracy) →](Governance.md)** · **[Room Best Practices →](Room_Best_Practices.md)** · **[Live Testing (2+ people) →](Live_Testing.md)** · **[RhoQuCalc Macros — protocols as verified ρ-processes →](RhoQuCalc_Macros.md)**

**Case studies:** **[Multi-Stakeholder Governance →](GovernanceCaseStudy.md)** · **[Collaborative Learning →](CollaborativeLearningCaseStudy.md)** · **[Specialist Closure Room →](SpecialistRoomCaseStudy.md)** · **[Framework Self-Inquiry (draft) →](SelfInquiryCaseStudy.md)**

## Choose your path

| You are… | Start here | Then |
|---|---|---|
| **Using it** — joining a room, deciding things together | **[Open a room](https://rhovision-org.github.io/quantum-os/)** · [User Guide](User_Guide.md) · [My Room](MyRoom.md) | [Group Decisions](Group_Decisions.md) · [Governance](Governance.md) · [Room Best Practices](Room_Best_Practices.md) · the demos below |
| **Building it** — compiling, running a node, the wire contracts | [Quick Start](#quick-start) · [Build commands](#build-commands) · **[docs/architecture.md](docs/architecture.md)** | [docs/connection.md](docs/connection.md) · [docs/commands.md](docs/commands.md) · [SECURITY.md](SECURITY.md) · [Testing](#testing) |
| **Extending it** — agents, macros, a chain behind the room | [Developer Guide](Developer_Guide.md) · [scripts/qos-cli](scripts/qos-cli/README.md) | [MacRhoLang](MacRhoLang.md) · [docs/rholang.md](docs/rholang.md) · [scripts/localnet](scripts/localnet/README.md) · **[The public testnet](https://github.com/rhovision-org/rholo/blob/dev/docs/src/node/testnet.md)** (the live net: hosts, genesis, the verified onboarding path, r-wallet) · [CLAUDE.md](CLAUDE.md) (the per-feature module map) |
| **Understanding it** — why ZFA is the security model, the proofs | [Manifesto](Manifesto.md) · **[quantum-logical-framework](https://github.com/rhovision-org/quantum-logical-framework)** (Lean 4, 218 modules, zero `sorry`) | [Consensus](Consensus.md) · [Collective Optimization](Collective_Optimization.md) · [RhoQuCalc Macros](RhoQuCalc_Macros.md) · [Related](#related) |
| **Planning it** — what is designed but not yet code | [Roadmap](#roadmap--what-is-design-not-code) | the [`feature`](https://github.com/rhovision-org/quantum-os/issues?q=is%3Aissue+is%3Aopen+label%3Afeature) issues |

Everything linked from the first four rows is **running code or a verified proof**; the last row is the only place a design lives without an implementation behind it.


### How to create reality together

1. Open **https://rhovision-org.github.io/quantum-os/** in your browser.
2. Click **Connect** — you join a room identified by a ZFA capability token in the URL hash. Your peer ID is a ZFA-balanced process.
3. Copy the share link and send it to someone (or open a second tab).
4. The second peer clicks **Connect** — both appear in the **Peers** list.
5. The **Room Process** panel shows the combined `parallel(you, peer)` process — ZFA-balanced across all peers.
6. Run QLF slash commands (`/braket +`, `/qucalc ^v`) — output broadcasts to every peer in the room.
7. Click a peer's name to instantly evaluate their ZFA process with `/qucalc`.
8. Use `/lemma` to name a logical claim — write it as a sentence and mark the handle with `@` (`/lemma All men are @mortal`); twists auto-allocate from the handle, or supply them after a pipe (`/lemma All men are @mortal | ^v`). Reference with `@mortal` in any command (`/qucalc @mortal @socrates` deduces from both). Lemmas sync to all peers and persist across page reloads.
9. Use `/grant [label]` to mint a random ZFA capability token and share it as a proof object.
10. Use `/request name` to signal you need a named lemma; the holder sees a prompt and can `/pass name peer` to transfer it directly — no token strings to copy.

Beyond evaluation, a room is a full collaboration space: take **group decisions** (`/poll`, `/estimate`, the `/probe` consensus check, trust-weighted `/gov` liquid democracy); invite **AI agent members** — a trust-governed *facilitator*, *scribe*, and *skeptic* that join as full peers and run on a Claude subscription ([Developer Guide](Developer_Guide.md)); and run the room as a **quantum problem solver** (below). New here? Start with the **[User Guide](User_Guide.md)**.

The room URL encodes a ZFA capability token in the hash (`#room=cap:room:…`). Anyone with the link can join — no account needed. The public signaling server (`wss://quantum-os-signaling.onrender.com`) is used by default; edit the field to point at a self-hosted server.

### The room as a quantum problem solver

**A QuantumOS room optimizes the way a quantum annealer actually does — by relaxing toward a low-energy consensus, not by "trying every answer at once."** Many minds (human *and* AI) propose candidates in parallel; the room scores them cheaply and **trust-weighted**; a facilitator lowers the "temperature" each round — explore wide early, refine the leader late — until the room settles on a ZFA-balanced closure and records it with `/lemma` + `/persist`. That is a physically faithful metaheuristic: the [Quantum Logical Framework](https://github.com/rhovision-org/quantum-logical-framework) says the substrate itself selects by closure / least free action (`ΔF = −log 2` per event), and the room realizes that same selection principle at the *logical* layer where human-meaningful problems live.

- **`/facil optimize <objective + constraints>`** — an AI facilitator runs a round: proposes candidates, suggests the scoring step (`/estimate` or `/poll`), and on the next call refines the leaders (the *anneal*) toward `/probe` → `/lemma`.
- **`/search [position]`** — the possibility step made literal, and **the search is the experiment**: the browser enumerates the admissible **next closures** from the room's current QuCalc position — the a-priori possibility space the room is annealing over — and asks the substrate which of them close from *here* (truth divination; truth is what closes). A port of the [QLF reference](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QucalcSearch.md), run locally — no service. Bare `/search` runs one enumeration over every peer's position with shared listeners — a **meeting of minds**, the room reading its own possibility space.
- **`/solve [position]`** — the selection step: **`/search` renders every way to close; `/solve` finds the solution, or the path to it.** It picks the one closure the substrate takes by a deterministic least-free-action cascade (so every peer agrees), widening the horizon until something closes; on a miss it reports the residual — what a completion still owes.
- **Why a room, not a QPU:** runs in a browser with nothing to cool; takes the problem in plain language (no lossy QUBO/Ising encoding); handles soft, qualitative, evolving objectives an energy function can't express; and every step is explainable and dyncap-auditable — a trust-weighted decision trail, not a black-box bitstring.

**Honest scope:** like every metaheuristic — and like a real annealer — it finds *good* solutions, not provably optimal ones; it is not an NP solver. Full method, worked example, and the QLF grounding: **[Collective Optimization →](Collective_Optimization.md)** · runnable demo (a room session converging to the brute-force TSP optimum): **[OptimizationDemo.md →](OptimizationDemo.md)** (`node scripts/qos-cli/optimize-demo.mjs`).

**Foundation:** [Quantum Logical Framework](https://github.com/rhovision-org/quantum-logical-framework) — ZFA (Zero Free Action) is the security model. Every peer identity is a ZFA-balanced capability token. Possessing a token IS authorization (Curry-Howard for capabilities). The room process `parallel(peer1, peer2, …)` is machine-verified to stay ZFA-balanced under composition — decoherence is impossible by construction.

---

## Commands

The room is driven from the chat input. The ten you need on day one are in the
[User Guide's cheat-sheet](User_Guide.md#cheat-sheet); **every command, with its output
and the source file behind it, is in [docs/commands.md](docs/commands.md)**. By family:

| Family | Commands | Doc |
|---|---|---|
| Identity & room | `/name` `/password` `/login` `/id` `/room` `/conn` `/ice` `/dyncap` | [SECURITY.md](SECURITY.md) · [docs/connection.md](docs/connection.md) |
| QLF kernel | `/braket` `/qucalc` `/conj` `/coupling` `/zfa` `/cap` `/search` `/solve` | [Collective_Optimization.md](Collective_Optimization.md) |
| Claims & value | `/lemma` `/grant` `/request` `/pass` `/note` `/rdv` `/persist` `/forget` | [PromissoryNoteDemo.md](PromissoryNoteDemo.md) · [AtomicSwapDemo.md](AtomicSwapDemo.md) |
| Deciding | `/poll` `/estimate` `/probe` `/gov` `/channel` | [Group_Decisions.md](Group_Decisions.md) · [Governance.md](Governance.md) · [Consensus.md](Consensus.md) |
| Agents | `/facil` `/scribe` `/skeptic` `/observer` `/greeter` | [scripts/qos-cli/README.md](scripts/qos-cli/README.md) |
| Macros & chain | `/macro` `+name` `$name` `/rhoqu` `/rholang` | [MacRhoLang.md](MacRhoLang.md) · [docs/rholang.md](docs/rholang.md) |
| Media & files | Call bar · `/record` · `/file` · `/render` | [Media_Libraries.md](Media_Libraries.md) (design) |

---

## Quick Start

```bash
bash scripts/setup.sh   # installs Rust, wasm-pack, Node, pnpm; builds everything
```

Then in two terminals:

```bash
pnpm dev:signaling      # WebSocket signaling server on ws://localhost:4444
pnpm dev:browser        # browser dev server (Vite)
```

### Manual setup

```bash
# 1. Rust + wasm-pack
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack
rustup target add wasm32-unknown-unknown

# 2. Node + pnpm
# install Node 20+ via nvm or your package manager
npm install -g pnpm

# 3. Build WASM kernel (must run before pnpm install)
pnpm build:wasm

# 4. JS dependencies
pnpm install

# 5. Build signaling server
pnpm build:signaling
```

---

## Build commands

| Command | What it does |
|---|---|
| `pnpm test:rust` | Run all Rust unit tests |
| `pnpm build:wasm` | Build `crates/zfa-core` → WASM via wasm-pack |
| `pnpm build:signaling` | Compile signaling server TypeScript |
| `pnpm dev:signaling` | Start signaling server (ws://localhost:4444) |
| `pnpm dev:browser` | Vite dev server for browser peer |
| `pnpm build` | Full build: WASM + signaling + browser |

---

## Testing

| Layer | Runs in CI | Command |
|---|---|---|
| Rust kernel | ✓ | `pnpm test:rust` |
| Browser TypeScript | ✓ | `pnpm --filter @quantum-os/browser typecheck`; `node packages/browser/test/<name>.test.mjs` |
| Plain-JS modules (`--selftest`) | ✓ | `node packages/browser/src/macro-lang.js --selftest` (and `locker.js`, `rholang-exchange.js`, `wrapped-token.js`, `scripts/qos-cli/rholang-macros.mjs`) |
| Headless peer (`scripts/qos-cli`) | ✗ — outside the workspace | the `*.selftest.mjs` / `*.e2e.mjs` list in [scripts/qos-cli/README.md](scripts/qos-cli/README.md#verify-offline-no-network-no-deps) |
| Document network | ✓ | `python3 scripts/doc_network_check.py` — no orphaned `.md`, no dead relative link |
| **Two real peers, two networks** | ✗ — needs people | **[Live_Testing.md](Live_Testing.md)** — rows L1–L12; L1–L4 after any change to the connect/call path |

---

## Architecture

```
crates/zfa-core/        Rust — the ZFA kernel → WASM (browser) and native
packages/signaling/     TypeScript — WebSocket signaling relay (never sees data-channel contents)
packages/browser/       TypeScript — the WebRTC peer + the app; loads the WASM kernel
scripts/qos-cli/        Node — headless peer, memory daemon, agents, bridge (outside the workspace)
scripts/localnet/       a local rnode to develop `/rholang` against
```

Cargo workspace + pnpm workspace. **The full engineering parent — layout, the security model
as the code enforces it, the browser peer API, the Rust kernel, the signaling wire protocol,
the WASM exports — is [docs/architecture.md](docs/architecture.md).**

**Security in one paragraph.** Every identity, room, claim and unit of value is a ZFA
capability token: a twist history that is both count-balanced and Pauli-closed, minted by
rejection sampling so an unbalanced token cannot be issued
([`crates/zfa-core/src/capability.rs`](crates/zfa-core/src/capability.rs)). Possessing the
token *is* the authorization; there is no account and no server-side state. The proof that
count balance implies Pauli closure is
[`count_balanced_pauli_closed`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_TwistAlphabet.lean);
the threat model, known issues and reporting policy are [SECURITY.md](SECURITY.md).

---

## Headless peer, memory, agents (`scripts/qos-cli`)

A Node peer that speaks the browser's exact wire protocol: **one-shot announce**
(`qos-cli.mjs`), a **memory daemon** that persists and re-serves a room's public state so
knowledge survives every browser leaving (`qos-daemon.mjs`), **AI agent members** —
facilitator, scribe, skeptic, greeter, observer (`agent.mjs`, [Developer Guide](Developer_Guide.md)) —
and a **bridge** that stands in two rooms at once ([Room_Bridges.md](Room_Bridges.md)).

```bash
cd scripts/qos-cli && npm install
node qos-cli.mjs --room "<cap:room:… | room-URL>" --message "hello room"
bash run-agents.sh "" facilitator observer      # defaults to the MyRoom test room
```

Rooms are peer-to-peer: a message reaches only the peers present at that moment; the daemon
is the room's persistence layer, not a server. Full docs: **[scripts/qos-cli/README.md](scripts/qos-cli/README.md)**.

---

## Status

| Component | Status |
|---|---|
| ZFA Rust kernel | ✓ 25/25 tests pass (both faces of half-spin closure checked: Pauli scalar return ∧ Hermitian-pair count balance) |
| Pauli matrix closure | ✓ `pauli_fold` / `is_pauli_closed` in Rust, TS, and QLF Python — the SU(2)-scalar-return face of `achieves_zfa` since v0.17 |
| WASM build | ✓ wasm-pack, wasm-bindgen |
| Signaling server | ✓ deployed — wss://quantum-os-signaling.onrender.com |
| Browser TypeScript | ✓ 0 type errors |
| WebRTC peer | ✓ join/peers/offer/answer/ICE/data channel |
| Connection reliability | ✓ WS heartbeat (25s ping), auto-reconnect, ICE failure detection |
| Collaborative QLF broadcast | ✓ `/braket`, `/qucalc`, `/id`, `/room` share output to all peers |
| Room Process panel | ✓ `parallel(peer1, peer2, …)` ZFA balance shown in sidebar |
| Capability token exchange | ✓ `/grant` mints and shares ZFA caps across peers |
| Click-to-qucalc | ✓ click a peer → `/qucalc cap:peer:…` filled in input |
| Promissory notes | ✓ `/note declare`/`grant`/`pass`/`redeem`/`split`/`merge` — bearer denomination as twist length |
| Receipt coins | ✓ `cap:receipt-<currency>:…` issued back to redeemer; permanent, non-transferable |
| Sidebar wallet | ✓ Currencies + Notes blocks render from per-room localStorage |
| Room state sync | ✓ on data-channel open, exchange lemma store + currency registry; bearer state stays private |
| N-party rendezvous | ✓ `/rdv swap`/`accept`/`reject`/`abort` with ZFA conservation over joint composition; token locking + 60s timeout |
| Dynamic capabilities | ✓ `/dyncap` — hash-only chain identity; TOFU + fork-detection on `name`, `lemma`, `note-declare`; SHA-256 from `crypto.subtle` only |
| Multisig (2-of-2) | ✓ `/dyncap`-anchored identity + `/rdv` atomic agreement; see MultisigDemo.md |
| Joiner-local consensus probe | ✓ `/probe` — chain-weighted supermajority resolution on join; losing peers ignored for sync; see Consensus.md |
| Lemma immutability | ✓ once `@name` is declared, re-declaration with different twists is refused locally and on inbound broadcast |
| Multi-room tabs | ✓ `/room join/leave/list/ref` — one browser session, N joined rooms; per-room state and signaling; unread indicator on background tabs |
| Per-room dyncap chain | ✓ same anchor across rooms (`H(seed)`), independent `seq` per room; `H(seed ‖ seq ‖ room_id ‖ payload_hash)` witnesses algebraically independent |
| Markov-blanket isolation | ✓ rooms are independent ZFA processes; no cross-room signaling, sync, or consensus; bridge peers are application-level only |
| Bridge primitive | ✓ `/share <selector> to <room>` — explicit bridge of lemma/chat/note into another joined tab |
| Counter-offer rounds | ✓ `/rdv counter <id> <giveCur> <giveN> <getCur> <getN>` — round-trip negotiation in an in-flight rendezvous |
| Tagged messaging | ✓ `/channel listen/send` — name-tagged broadcast with per-receiver subscription filter |
| Sequential command chain | ✓ `/script cmd1; cmd2; …` — batch dispatch on one line |
| Cross-peer persistence | ✓ `/persist @lemma to <peer>` — agreed replication of public state with explicit accept/reject |
| RhoQu macro language | ✓ `/rhoqu` — `process` / `new` / `\|` parallel / `if` / `on channel` / `for` transpile to dispatcher commands; handlers persist per-room |
| Mobile viewport | ✓ `100dvh` + `interactive-widget=resizes-content` — input stays above the Android keyboard; not clipped on mobile Firefox |
| GitHub Pages | ✓ https://rhovision-org.github.io/quantum-os/ |
| Headless CLI peer | ✓ `scripts/qos-cli` — one-shot join + broadcast (Node + werift); ZFA/dyncap ported and self-tested |
| Memory-peer daemon | ✓ persistent signed peer — persists + re-serves lemmas/currencies/transcript; stable identity; verified werift↔browser live |
| Native Rust peer | Planned |

---

## Roadmap — what is design, not code

Everything above runs. These are written down but **not implemented**; each is tracked by an
issue, and a design document says so in its first lines:

| Design | Doc | Issue |
|---|---|---|
| Libraries of audio and video built in a room | [Media_Libraries.md](Media_Libraries.md) | [#99](https://github.com/rhovision-org/quantum-os/issues/99) |
| Cross-shard CapTP: revocable proxies, promise pipelining (Layer 2; Layer 1 in draft) | [CapabilityTransport.md](CapabilityTransport.md) | [#173](https://github.com/rhovision-org/quantum-os/issues/173) · [#107](https://github.com/rhovision-org/quantum-os/issues/107) |
| Group-process protocols as verified ρ-processes | [RhoQuCalc_Macros.md](RhoQuCalc_Macros.md) (design spec + case studies) | — |
| A group as an identity, consent-gated memory, trust-gated library | — | [#103](https://github.com/rhovision-org/quantum-os/issues/103) · [#106](https://github.com/rhovision-org/quantum-os/issues/106) · [#105](https://github.com/rhovision-org/quantum-os/issues/105) |
| rnodes as room members, chain-backed channels and records | — | [#138](https://github.com/rhovision-org/quantum-os/issues/138) · [#78](https://github.com/rhovision-org/quantum-os/issues/78) · [#96](https://github.com/rhovision-org/quantum-os/issues/96) |
| Agents that do the work (standard AI integrations, a Lean-proof agent) | — | [#132](https://github.com/rhovision-org/quantum-os/issues/132) |
| Native Rust peer | — | planned |

The live list is the [`feature`](https://github.com/rhovision-org/quantum-os/issues?q=is%3Aissue+is%3Aopen+label%3Afeature)
label. A doc PR that adds a design must land it here, not in the sections above
(the review checklist is in [CLAUDE.md](CLAUDE.md#documentation-prs)).

---

## Related

**[quantum-logical-framework](https://github.com/rhovision-org/quantum-logical-framework)** — the Lean 4 formal proof repo that underpins this app. Zero `sorry` blocks across 218 modules. Key documents:

| Document | Relevant to |
|---|---|
| [README.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/README.md) | Overview; "Try in the browser" section with `/braket` and `/qucalc` examples |
| [AI.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/AI.md) | Quantum AI and syllogism solving — live collaboration script showing two peers prove "Socrates is Mortal" with `/qucalc`, `/braket`, `/grant` |
| [BraKetRhoQuCalc.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/BraKetRhoQuCalc.md) | `/braket` — `action`=ket, `lift`=bra, `parallel`=superposition; `bra_ket_always_balanced` proof |
| [QuantumOS.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QuantumOS.md) | `/qucalc` — ZFA as OS kernel; `full_zeno_prune` as security, GC, and error correction |
| [QuCalc.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QuCalc.md) | The 8-twist alphabet `{^v<>/\+-}`; ZFA generation engine |
| [Maxwell.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Maxwell.md) | Maxwell equations from ZFA; `no_magnetic_monopoles` (∇·B=0) |
| [Lagrangian_Formulation.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Lagrangian_Formulation.md) | ZFA as ℒ=0 (null Lagrangian = condition of origin); variational grounding |
| [Philosophy.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Philosophy.md) | Possibilist ontology; ZFA as the sole selection principle |

**Lean source files** (machine-verified, zero `sorry`):

| File | Theorems |
|---|---|
| [lean/RhoQuCalc.lean](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) | `rho_process_always_zfa`, `action`, `lift`, `parallel` — `/id`, `/qucalc` |
| [lean/BraKetRhoQuCalc.lean](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean) | `bra_ket_always_balanced`, `action_topo_is_ket`, `lift_topo_is_bra` — `/braket` |
| [lean/SpacetimeDynamics.lean](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/SpacetimeDynamics.lean) | `Form.toMatrix_adjoint` — Hermitian matrix used by `/braket` |
| [lean/QLF_Axioms.lean](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_Axioms.lean) | `achieves_ZFA`, `spectral_gap`, `full_zeno_prune` — `/zfa`, `/qucalc` |
| [lean/QLF_Universality.lean](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_Universality.lean) | `qlf_universality` — every terminating computation IS a ZFA string |
