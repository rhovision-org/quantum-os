# RhoQuCalc Macros — group-process protocols as verified ρ-processes

**Status:** Design spec + three worked case studies. Grounds the macro layer in the machine-verified
ρ-process algebra ([`RhoQuCalc.lean`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean), [`BraKetRhoQuCalc.lean`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean)) rather than the ad-hoc `/rhoqu` parser alone.

A [quantum-os](README.md) room already has a rich primitive set (`/poll`, `/probe`, `/rdv`, `/gov`, `/lemma`+`/persist`,
`/channel`, `/note`, `/grant`, `/cap`, `/conj`, `/script`, `/rhoqu`). The hard parts are built; what's
missing is a way to **compose them into named, guided, shareable protocols**. That composition layer is
**macros** — and a macro is best expressed as a **`RhoProcess`** (a quoted ρ-calculus term), because then
it inherits the verification for free.

## Why RhoQuCalc, not just RhoQu

- **RhoQu** (`/rhoqu`, `packages/browser/src/rhoqu.ts`) is the *surface syntax* that lowers to `/commands`.
- **RhoQuCalc** ([`RhoQuCalc.lean`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean)) is the *machine-verified ρ-process algebra*.

Grounding macros in RhoQuCalc buys, by construction:

- **ZFA well-formedness is a theorem, not a runtime check.** `rho_process_always_zfa` /
  `bra_ket_always_balanced`: *every constructible `RhoProcess` is ZFA-balanced.* A malformed protocol is
  inexpressible.
- **Reflection is the macro mechanism.** A ρ-calculus name is a **quoted process** (`@P`); running it is
  **eval** (`*x`). A macro = a name; a macro library = a set of names; "adopt" = share the name.
- **Capability security comes with it.** Names are unforgeable capabilities (Miller O-cap + ρ-calculus):
  **possessing the macro name *is* authorization to run it.**
- **One algebra for physics and collaboration.** A group-process macro and a particle closure are the
  *same* formal object — a `RhoProcess`.

## The `/command` ↔ `RhoProcess` mapping

| `RhoProcess` | role | topo (`toTopoString`) | `eval` | `/commands` it compiles |
|---|---|---|---|---|
| **`action f`** | **assert / open** an obligation — ket `\|ψ⟩` | `[pos, neg]` | `f.toMatrix` | `/lemma`, `/grant`, `/cap`, `/note declare`, `/poll <open>`, `/gov <open issue>`, `/rdv <propose>`, `/share`, `qlf-propose` |
| **`lift f`** | **consume / discharge** an obligation — bra `⟨ψ\|` | `[neg, pos]` | `f.toMatrix†` | `/poll vote`, `/probe`, `/gov vote`, `/note redeem`, sign/ack, `zfa-check` |
| **`sequence p q`** | p **then** q (ordered) | `topo p ++ topo q` | `p.eval * q.eval` | `;` · `/script a; b` · phase ordering |
| **`parallel p q`** | p **and** q (concurrent / superposed) | `topo p ++ topo q` | `p.eval + q.eval` | concurrent peers · fan-out · alternatives |
| **`dagger p`** | **adjoint / undo / dual** | reverse·conj | `(p.eval)†` | `/conj` (the kernel adjoint) · revoke · `/gov undelegate` · rollback |

Two facts make this exact, not analogy: `/conj` *is* the adjoint in the kernel, so `dagger` maps to it
natively; and `sequence` vs `parallel` differ as **product (ordered) vs sum (concurrent)** in `eval`.

**The `Form` encoding.** A command verb carries a small fixed `Form` (Pauli-coordinate signature) — just
enough to give `action`/`lift` a balanced witness. The command's *content* (proposal id, value, payload)
lives in the **name's reflection** (the quote), not the matrix: the `Form` types the *role*, the name
carries the *data*.

**Closure = a ket met by its bra.** A proposal is `action f` (an outstanding obligation); a resolution is
`lift f`. `sequence (action f) (lift f)` folds (`eval = f.toMatrix · f.toMatrix† = ` scalar) — the closed
**decision of record** (`/lemma … /persist`). That scalar *is* the receipt. (This exact term is Lean-checked
ZFA at `BraKetRhoQuCalc.lean:234`.)

**A closure gate** (required dissent) is *structural*: the macro schema requires a `lift f_role` to appear
in the `sequence` **before** the closing `action f_decision`. The gate lives in the term, not in policy.

**Proven vs runtime.** RhoQuCalc proves the macro is **well-formed / ZFA-balanced** (and reflective,
capability-bearing). It does **not** prove the *semantic* discharge of an obligation (quorum met, the right
role responded) — that stays a **runtime ledger predicate** the `/commands` realize. Twist-balance proves
*structure*; the ledger proves *effect*.

## The layering

**RhoQu surface syntax → `RhoProcess` term (verified, reflective, capability-bearing) → `/commands` (runtime).**
Today `rhoqu.ts` lowers straight to `/commands`; the spec inserts the **`RhoProcess` as the intermediate
representation**, so a macro is a Lean-checkable term whose *name* is shared and persisted across the mesh.

---

# Three case studies (as RhoQuCalc macros)

> Each macro below also has a **standalone case-study doc** with the full scenario:
> [`GovernanceCaseStudy.md`](GovernanceCaseStudy.md) (#26),
> [`SpecialistRoomCaseStudy.md`](SpecialistRoomCaseStudy.md) (#24),
> [`CollaborativeLearningCaseStudy.md`](CollaborativeLearningCaseStudy.md) (#25).

Each grounds a gemini-generated case study in the **real** quantum-os commands (the gemini drafts invented
commands like `qlf-action`, `/sys/gov`, `colab-tally` — here those are real verbs: `/qlf-action`,
`/zfa-check`, and `/estimate` are now built). Read each as: the `RhoProcess` structure, lowered to the commands.

## 1. `gov-9stage` — multi-stakeholder governance (was: blockchain governance case study)

The 9-stage decision loop as a right-nested `sequence`, over the existing **liquid-democracy** `/gov`,
`/poll`/`/probe` tally, and `/lemma`+`/persist` decision-of-record. Liquid delegation is a `dagger`-revocable
trust vector.

```
gov-9stage(issue) :=
  sequence (action  /lemma  issue@identify)          ── 1 Identify     : assert the problem of record (ket)
  sequence (action  /lemma  issue@goal)              ── 2 Define goal
  sequence (action  /channel issue "solutions")      ── 3 Source       : open deliberation (ket)
  sequence (lift    /estimate issue --median)        ── 4 Evaluate&size: median group estimate  [/estimate ✅]
  sequence (lift    /gov vote issue)                 ── 5 Select       : weighted liquid-democracy tally (bra)
  sequence (action  /lemma  issue@deploy)            ── 6 Deploy       : assert the chosen artifact
  sequence (lift    /probe  issue@monitor)           ── 7 Monitor      : consensus snapshot on live metrics
  sequence (dagger  (/lemma issue@deploy))           ── 8 Adjust       : amend/rollback = adjoint
           (action  /lemma  issue@lesson) /persist   ── 9 Lesson       : persist the closure receipt
```
- **Liquid democracy is already built** (`/gov delegate` / `undelegate`, standing/transitive — see
  [`Governance.md`](Governance.md)); `dagger` is the `undelegate`/amend dual.
- **Median tally** is `/estimate --median` (built — `new`/`<number>`/`status`/`close`, mesh-synced), robust to whale/outlier — the
  gemini "Group Estimate median."
- The gemini "sentiment sliders / pros-cons" UI is an optional surface over `/estimate` + `/channel`.

## 2. `specialist-closure` — the complementary-specialist room (PFEM demo)

Turns the [`Room_Best_Practices.md`](Room_Best_Practices.md) rules ("no proposal closes without a dissent
role") from prose into a term. The **closure gate** is the required `lift …@skeptic` before the closing
`action`.

```
specialist-closure(proposal) :=
  sequence (action /channel proposal)          ── Proposer   : open the claim (ket)
  sequence (lift   /probe   proposal@skeptic)  ── Skeptic    : discharge a check (bra) ◄ CLOSURE GATE
  sequence (lift   /note    proposal@evidence) ── Evidence   : record status (claim / verified / speculation)
           (action /lemma   proposal) /persist ── Integrator : assert + persist the decision of record
```
- Drop the `lift …@skeptic` and the term no longer matches the schema — the gate is structural.
- `rho_process_always_zfa` certifies the whole term is balanced.
- Needs a **closure-gate** primitive to *enforce* the schema at runtime (today it is by convention); the
  scripted clones-vs-specialists demo in `Room_Best_Practices.md` §*Demo room* shows the payoff.

## 3. `colab-study` — collaborative QLF testing (was: collaborative education case study)

Peers in a channel jointly run QuCalc history strings against the **real** `zfa-core-wasm` kernel
(`packages/browser/src/zfa.ts`), each verifying locally (the `parallel` fan-out), then closing on a median
tally.

```
colab-study(history-string) :=
  sequence (action /qlf-action history-string)   ── Peer A proposes; kernel evaluates the string  [/qlf-action ✅]
  sequence (parallel (lift /zfa-check --peer=B)   ── all peers verify locally, concurrently  [parallel + lift]
                     (lift /zfa-check --peer=C))                                              [/zfa-check ✅]
  sequence (lift   /estimate --median)            ── group tallies impact (median)  [/estimate ✅]
           (action /lemma history-string) /persist ── record the verified closure (receipt)
```
- `/qlf-action` and `/zfa-check` are **thin room-broadcast wrappers** over the existing
  `zfa-core-wasm` ZFA kernel (`is_zfa = is_count_balanced ∧ is_pauli_closed`) — the physics is unchanged, just the
  collaborative surface. `/conj` already exposes the adjoint for probing `H = H†` histories.

## What runs today vs. what is still open

| Needed by the macros | Status |
|---|---|
| `/poll`, `/probe`, `/gov` (+ liquid delegation), `/lemma`+`/persist`, `/channel`, `/note`, `/conj`, `/script`, `/rhoqu` | ✅ built |
| **`/estimate`** (median/IQR group estimate, whale-resistant; `--mean` opt) | ✅ built — `new <q>` · `<number>` · `status` · `close`, mesh-synced (reused by gov-9stage + colab-study) |
| **`/qlf-action` / `/zfa-check`** (thin wrappers over `zfa-core-wasm`) | ✅ built — propose a history string + verify `is_count_balanced ∧ is_pauli_closed` locally (colab-study) |
| `RhoProcess` as the macro IR + `RhoQu → RhoProcess` lowering | 🔵 the spec's one formal piece (the verb→`Form` table + lowering) |
| **Shareable / persistent macro *names*** across the mesh (`/rhoqu` macros are per-tab today) | 🔵 the PFEM "adopt a protocol once" layer |
| **RhoQu variable binding** (`let id = /rdv …`, `$LAST_ID`) | 🔵 already flagged in [`RhoQuDemo.md`](RhoQuDemo.md) ("commit 5 candidate") |
| **closure-gate** (enforce required-dissent at runtime) | 🔵 a room-closing *policy* over `/lemma` (specialist-closure) — by convention today |

## Honest scope

This spec + the three macros capture the **design** of the protocols as verified ρ-terms, grounded in real
commands (replacing the gemini drafts' invented commands). The thin verbs the macros need — `/estimate`
(median/IQR, mesh-synced), `/qlf-action`, and `/zfa-check` — are built. The remaining open pieces are the
macro IR/lowering, mesh-shared macro names, and the closure-gate *policy* over `/lemma`; the **live
Room-A-vs-Room-B demonstration** (saving comparable closure ledgers) remains the PFEM-room-demo deliverable.
The verification (a macro is ZFA-balanced, reflective, capability-bearing) is inherited from RhoQuCalc; the
*effect* of each command stays a runtime concern.

See [`Room_Best_Practices.md`](Room_Best_Practices.md), [`Group_Decisions.md`](Group_Decisions.md),
[`Governance.md`](Governance.md), [`RhoQuDemo.md`](RhoQuDemo.md), and QLF's
[`zfa-catalog-rho-notation.md`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/zfa-catalog-rho-notation.md)
(the closure-catalog parallel — macros are its group-process analogue).
