# Case Study — Collaborative Learning (CoLab QLF Testing)

**Issue:** [#25](https://github.com/rhovision-org/quantum-os/issues/25) · **Macro:** `colab-study` ([`RhoQuCalc_Macros.md`](RhoQuCalc_Macros.md)) · **Built on:** the `zfa-core-wasm` kernel (`packages/browser/src/zfa.ts`), [`RhoQuDemo.md`](RhoQuDemo.md)

A peer-to-peer study room where learners jointly test the Quantum Logical Framework — running QuCalc
history strings, checking Zero Free Action (ZFA) closure, and reaching a group verdict on a shared ledger.
Every command is processed locally by each browser's WASM ZFA kernel and synced over WebRTC.

## The scenario

Instead of one person "owning" a test, the group uses **consensus-weighted assertions**:

1. **Peer A proposes** a QuCalc history string (e.g. `^v<>/\`).
2. **Every peer verifies locally** — each browser drops the string into its own ZFA kernel and checks
   closure independently (no trusted evaluator).
3. **The group tallies** a robust median impact estimate and records the verified closure.

This is collaborative-learning best practice: a room of complementary learners *explores* the space; a
room of clones re-derives the same answer (see [`Room_Best_Practices.md`](Room_Best_Practices.md)).

## Grounded in the real commands

The original (gemini) draft invented `qlf-action`, `zfa-check`, and `colab-tally`. The real kernel already
does the physics; these become **thin room-broadcast verbs** over it:

| Step | Real [quantum-os](README.md) mechanism |
|---|---|
| Join a study channel | `/channel "qlf-zfa-study"` — a shared, signed deliberation context |
| Propose a history string | **`/qlf-action "<string>"`** — broadcast + evaluate on the local kernel *(built: a thin verb over `zfa-core-wasm`, `is_zfa = is_count_balanced ∧ is_pauli_closed`)* |
| Each peer verifies | **`/zfa-check <string>`** — every browser re-evaluates locally, showing both conjuncts *(built)* |
| "What closes from here?" | **`/search <string>`** — enumerate the admissible next closures; **`/solve <string>`** — the one the substrate takes, or the residual action still owed. Both computed in the browser, so every peer gets the same answer with no service *(built, qos#119)* |
| Probe `H = H†` histories | `/conj <twists>` — the kernel adjoint (already built) for self-adjoint / critical-line study |
| Group estimate | **`/estimate --median`** — robust numeric tally *(built, mesh-synced, shared with governance)* |
| Record the result | `/lemma <claim>` (mark the handle: `/lemma The N=6 census closes @cs6 \| <string>`) + `/persist` — the verified closure of record (the receipt) |

The physics is unchanged — the ZFA kernel (`packages/browser/src/zfa.ts`, Lean-anchored in QLF) is
already shipped; `/qlf-action` / `/zfa-check` are the collaborative *surface* over it.

## The macro

```
colab-study(history-string) :=
  sequence (action /qlf-action history-string)               ◄ /qlf-action ✅
  ▸ sequence (parallel (lift /zfa-check --peer=B)            ◄ all peers verify, concurrently
                       (lift /zfa-check --peer=C))            ◄ /zfa-check ✅
  ▸ sequence (lift /estimate --median)                       ◄ /estimate ✅
  ▸          (action /lemma history-string) /persist
```

The `parallel` fan-out is the independent local verification; the closing `action /lemma` is the recorded
closure. As a ρ-process it is ZFA-balanced by construction — see [`RhoQuCalc_Macros.md`](RhoQuCalc_Macros.md).

## Runs today vs. open

- ✅ **Runs today:** the WASM ZFA kernel (local verification), `/channel`, `/conj`, `/lemma`+`/persist`,
  WebRTC sync, the **`/qlf-action` / `/zfa-check`** thin verbs (room-broadcast wrappers over the kernel),
  **`/search` / `/solve`** (the closure enumerator, browser-local — qos#119), and the **`/estimate` median**
  round (mesh-synced, `new`/`<number>`/`status`/`close`).
- 🔵 **Open:** the **macro IR + mesh-shared macro names** so a class adopts `colab-study` once.
  Tracked in [#24](https://github.com/rhovision-org/quantum-os/issues/24).
