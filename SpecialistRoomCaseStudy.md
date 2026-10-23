# Case Study — The Complementary-Specialist Closure Room

**Issue:** [#24](https://github.com/rhovision-org/quantum-os/issues/24) · **Macro:** `specialist-closure` ([`RhoQuCalc_Macros.md`](RhoQuCalc_Macros.md)) · **Built on:** [`Room_Best_Practices.md`](Room_Best_Practices.md)

The PFEM "receipt-bearing quadrature cell" made concrete: a room of **complementary specialists** reaches
a *better* closure than a room of clones — because distinguishable closures bind where identical ones are
redundant (the deuteron condition at the group scale).

## The scenario — clones vs. specialists

Same decision for both rooms: *"Should we ship feature F now?"*

**Room A — three clones (all Proposers).**
```
agent1: F is ready, ship it.   agent2: Agreed.   agent3: +1.
=> CLOSED (ship) in 3 messages. No failure mode examined. Groupthink.
```

**Room B — complementary specialists.**
```
Proposer:        Ship F now — the happy path works.
Skeptic:         How does F behave when the peer drops mid-handshake?
Evidence keeper: No test covers that. Status: unresolved/testable.
Integrator:      Close on "ship behind a flag, default off, until that test exists."
Operator:        Action: add the flag + the test; flip default when green.
Boundary keeper: In scope. The UI change is a separate closure.
=> CLOSED (ship behind flag + named test) — survived refutation, ledgered, actionable.
```

Room A was *faster*; Room B reached a *better* closure — one that survives the failure mode A never
examined. The Skeptic and Integrator are **distinguishable** from the Proposer, so they bind into a
closure the clones could not form.

## Grounded in the real commands

| Role / step | Real [quantum-os](README.md) mechanism |
|---|---|
| Open the proposal | `/channel proposal` — the claim (a ket / open obligation) |
| **Skeptic (required)** | `/probe proposal@skeptic` — a discharge (bra) that **must precede closure** ◄ the closure gate |
| Evidence keeper | `/note proposal@evidence` — status marked `claim` / `verified` / `speculation` |
| Integrator closes | `/lemma <the decision>` (a sentence, with the handle marked — `/lemma Ship the v2 @proposal now`) + `/persist` — the decision of record (the receipt) |
| Dissent before closure | structural: a `lift …@skeptic` must appear before the closing `action /lemma` |

The **closure gate** turns `Room_Best_Practices.md`'s rule ("no proposal closes unrefuted") from prose into
a *structural* requirement of the macro term — not a runtime policy that can be skipped.

## The macro

```
specialist-closure(proposal) :=
  sequence (action /channel proposal)            ── Proposer:   open the claim
  ▸ sequence (lift   /probe   proposal@skeptic)  ── Skeptic:    discharge a check ◄ CLOSURE GATE
  ▸ sequence (lift   /note    proposal@evidence) ── Evidence:   record status
  ▸          (action /lemma   proposal) /persist ── Integrator: assert + persist the decision of record
```

`rho_process_always_zfa` certifies the term is balanced; drop the `lift …@skeptic` and it no longer matches
the schema. See [`RhoQuCalc_Macros.md`](RhoQuCalc_Macros.md).

## Runs today vs. open (the live demo)

- ✅ **Runs today:** the scripted clones-vs-specialists scenario above; `/channel`, `/probe`, `/note`,
  `/lemma`+`/persist`, capability-token roles.
- 🔵 **Open — the acceptance criteria** ([#24](https://github.com/rhovision-org/quantum-os/issues/24)): a **live**
  run of Room A (clones) vs Room B (specialists) on the same decision, with **saved, comparable closure
  ledgers**, showing the specialist room catches the failure mode the clone room misses. Plus the
  **closure-gate** primitive (enforce required-dissent at runtime) and the **macro IR + mesh-shared macro
  names**.
