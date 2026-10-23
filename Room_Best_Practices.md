# Room Best Practices — reaching high-quality group closure

How a [QuantumOS](README.md) room reaches a **good** decision — not just *a* decision. Where
[`Group_Decisions.md`](Group_Decisions.md) covers the *mechanics* (polls, ranked choice,
`/probe` consensus, liquid democracy in [`Governance.md`](Governance.md)), this doc covers the
*composition and process* — who is in the room, what roles they play, and the checklist a closure
must pass before it counts.

The grounding principle comes from QLF
([**SEX.md**](https://github.com/rhovision-org/quantum-logical-framework/blob/main/SEX.md) — the
proton/neutron sex model, issue #53): **a higher-order closure formed by *complementary* parts
achieves what identical copies cannot.** Identical closures are Pauli-blocked from a shared state
(`pauli_exclusion`); a
proton and neutron bind into a deuteron precisely because they are *distinguishable*. The
group-scale version is the Woolley-2010 collective-intelligence factor — group quality is
predicted by diversity and social sensitivity, **not** by the smartest individual. A room of
clones re-derives the same closure; a room of complementary specialists explores the space.

**Plain-language version (the part that survives contact outside the QLF model):** *identical agents
tend to produce redundant closure; complementary specialists can produce higher-order closure.* The
"Pauli-blocked identical copies" phrasing above is the QLF *model* of this — accurate inside the
framework, but use the plain version in general settings so it doesn't read as physics cosplay.

> **A QuantumOS room is a structured closure environment, not a generic chat room.**

---

## What is a valid group closure?

A **group closure** is a configuration of the room's signed contributions that *all participating
blankets can consistently inhabit* — the QLF analogue of a ZFA-closed state. It is **not** a bare
majority count. A decision is closed when:

1. a candidate closure has been **stated** as a durable, attributable artifact (a signed
   envelope / lemma / poll result), and
2. it has **survived** at least one dissent/checking role, and
3. the **known / assumed / unresolved / testable** ledger is explicit, and
4. no single agent **dominated** the process that produced it.

If any of those fail, the room has *noise* or *groupthink*, not closure.

### Allen's question — impedance, delay, and higher-order effects

Higher-order effects are not magic; they are **delayed communication across impedance
boundaries**. Each agent is a Markov blanket with an *impedance* — what it will and won't let
through. A closure that no single blanket could reach emerges when partial closures pass between
complementary blankets over time (the constructing delay `Δt = R/f` of QLF): the Skeptic's
failure-mode, delayed and integrated by the Integrator, becomes a stronger Proposer closure than
either started with. The emergent, higher-order result *is* the room's joint closure — and it only
emerges if the impedances differ (complementarity) and the communication is allowed to iterate
(delay). Matched impedances (clones) reflect nothing new; mismatched impedances, given time,
transform.

---

## Role templates

A room reaches good closure when these roles are **filled by distinct participants** (human or
agent). One participant may hold more than one role in a small room, but the **Proposer and at
least one checking role (Skeptic or Boundary keeper) must be different participants**.

| Role | Purpose | Behaviour | Closure contribution |
|---|---|---|---|
| **Proposer** | Introduces a candidate closure | States a concrete, falsifiable proposal as a durable artifact | The seed configuration |
| **Skeptic** | Searches for failure modes | Actively tries to *refute* — "here's how this breaks" | Prevents premature / brittle closure |
| **Integrator** | Combines partial closures | Merges compatible fragments; finds the configuration that closes for the most blankets | Builds the joint closure |
| **Evidence keeper** | Tracks sources & assumptions | Maintains the known/assumed/unresolved/testable ledger; cites | Keeps the closure honest |
| **Operator** | Asks what action follows | "If we close here, what do we *do*?" | Grounds closure in consequence |
| **Boundary keeper** | Prevents scope explosion | Splits or defers out-of-scope threads; protects the room's focus | Keeps closure tractable |

**Templates are starting points, not cages** — a room may add roles (e.g. a *Dissent protector*
who ensures a minority voice is heard, the "at least one woman raises `c`" effect made
procedural). The point is **complementary coverage**, not a fixed cast.

---

## Room rules

1. **Do not require participants to be complete copies / full bisimulations.** Prefer
   complementary specialist roles — distinguishable closures bind where identical ones are
   Pauli-blocked.
2. **Require at least one dissent / checking role before closure.** No proposal closes unrefuted.
3. **Separate speculation from formalized claims.** Mark each artifact `speculation`, `claim`, or
   `verified` — never let a flagged guess masquerade as a closed result.
4. **Track what is known, assumed, unresolved, and testable** in an explicit, durable ledger.
5. **Record closure decisions as durable artifacts** (signed envelopes / lemmas), so late joiners
   re-sync the *decision*, not just the chatter (`sync-*` handshake, `Group_Decisions.md`).
6. **Avoid letting one agent dominate the closure process.** Even the turn-taking; a dominated
   room collapses to a single blanket and loses its collective intelligence. **And avoid two
   co-equal leaders** — a finding borne out in the research: two dominant voices *deadlock* into a
   rivalry rather than a closure. Seat **one** lead per role and let a second strong voice take the
   complementary *checking* role (rule 2), not a rival lead — exactly what the QuantumOS agents do by
   electing a single lead per duty. (In the QLF *model* this is the "social diproton" — two identical
   closures that can't bind,
   [`SEX.md`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/SEX.md) §3 — but the
   operational point holds in plain terms.)
7. **Use diversity of role, perspective, and model type as a closure-strengthening mechanism**, not
   an obstacle to manage away.
8. **Decompose to pairings.** The ideal initial group size is **two**; make a large room effective by
   maximizing complementary one-on-one pairings and decomposing activities down to pairs — then
   report up to the larger group (small teams, ~4 together, reporting to the whole). This is the
   deuteron principle as *process*, not just composition.
9. **Cap engaged expertise at about five.** Up to five experts measurably improve a group decision;
   beyond that, structure the room or split it — more voices without structure make decisions *worse*.
10. **Protect privacy and control.** Participants collaborate only when they trust their privacy and
    control are protected; competitors collaborate only around **explicitly shared principles**.
    Capability-scoped membership and dyncap signing are how a room earns that trust.
11. **Allow anonymity / pseudonyms.** Forthright contribution improves with pseudonymity, especially
    across a hierarchy where attribution chills dissent — pair it with rule 3 (separate speculation
    from claims) so anonymity raises candor without lowering rigor.
12. **Include the absent.** A reliable finding: only ~¼ of members use a collaboration system
    effectively unprompted; success often demands actively soliciting the silent — the closure the
    quiet quarter would have changed is the one most worth chasing.

---

## The evidence base — collective-intelligence findings

These room rules are not invented; they distil decades of computer-mediated-communication research
(the NJIT EIES legacy) and the QuantumOS author's own governance practice. The headline findings the
rules above operationalize ([Whitescarver, *Collective Intelligence Best Practices*](#references--related)):

- **Structure is what lets a group scale.** *Without* structure, the larger the group, the **worse**
  the decision; *with* structure (roles, norms, the closure checklist), a larger group beats its best
  individual — the "fifth voice" that exceeds any member's contribution.
- **The ideal initial group size is two.** Larger groups are made effective by maximizing the quality
  of individual pairings and decomposing work down to one-on-one — the process form of rule 8.
- **Up to five experts** improve a decision; engaging expertise past that yields diminishing returns.
- **Online, asynchronous groups participate equally.** Face-to-face groups tend to be dominated by one
  or two (often male) participants; structured online rooms equalize participation (gender-independent)
  — the empirical basis for rule 6 (non-domination) and rule 11 (pseudonymity).
- **Trust is a precondition, not a nicety.** People collaborate only when privacy and control are
  protected; competitors collaborate only on shared principles (rule 10).
- **Including the absent matters.** Roughly 25% of members use such a system effectively, 25% under
  group pressure, 25% over-adopt it, 25% never use it — so reaching the silent quarter is where most
  of the unrealized closure lives (rule 12).
- **Process practices that help:** seek **win-win-win consent** (from love, not fear — John Kellden);
  **experimentation over planning** (test alternatives against objective criteria); **equal
  participation** by soliciting everyone's concerns and objections; **working out loud**; **delayed
  choice**; **organic specialization**; and a little **serendipity / gamification**.

The QLF deuteron model and Woolley-2010 (below) are the *why*; these are the measured *that*.

---

## Closure checklist

Before a room declares a decision **closed**, run this checklist (the Evidence keeper owns it):

- [ ] **Stated** — the closure is a concrete, attributable, durable artifact.
- [ ] **Refuted-and-survived** — at least one Skeptic / Boundary keeper challenged it and it held.
- [ ] **Ledgered** — known / assumed / unresolved / testable are written down.
- [ ] **Speculation-separated** — no `speculation`-flagged item is being treated as `verified`.
- [ ] **Actionable** — the Operator has named what action follows (or "none, by design").
- [ ] **In scope** — the Boundary keeper confirms the decision is the room's to make.
- [ ] **Non-dominated** — more than one participant materially shaped the closure.
- [ ] **Complementary** — the closure drew on at least two distinguishable roles/perspectives.
- [ ] **Absent-considered** — the room asked who is *not* here that this closure affects, and either
      solicited them or recorded their absence as a known risk.

A closure that passes all nine is *durable*; one that fails any is *provisional* — record it as
such.

---

## Decision protocol — defer, split, escalate, issue

When a room cannot cleanly close, it should not force a brittle decision. Instead:

- **Defer** — if evidence is missing: the Evidence keeper records the gap as `unresolved/testable`
  and the room revisits when it's filled.
- **Split** — if the thread is really two decisions: the Boundary keeper splits it into separate
  closures (or sub-rooms), each with its own roles.
- **Escalate** — if the decision exceeds the room's franchise (its capability scope): escalate to
  a governing room (`Governance.md` liquid-democracy delegation) or the human owner.
- **Create a repo issue** — if the decision needs durable cross-session tracking or code/doc work:
  open a GitHub issue, link the room's closure artifact, and let the issue be the durable closure.

---

## Demo room — clones vs. complementary specialists

A worked scenario showing improved closure from complementarity. *(Scripted demonstration; deploy
a live room with `qos-cli`/`qos-daemon` to reproduce.)*

**Decision:** "Should the room adopt proposal X (ship feature F now)?"

**Room A — three clones (all Proposers).**
```
agent1: F is ready, ship it.
agent2: Agreed, F is ready, ship it.
agent3: +1, ship it.
=> CLOSED (ship) in 3 messages. No failure mode was examined. Groupthink closure.
```

**Room B — complementary specialists.**
```
Proposer:        Ship F now — the happy path works.
Skeptic:         How does F behave when the peer goes offline mid-handshake?
Evidence keeper: No test covers offline-mid-handshake. Status: unresolved/testable.
Integrator:      Then close on "ship F behind a flag, default off, until that test exists."
Operator:        Action: add the flag + the test; flip default when green.
Boundary keeper: In scope. Not bundling the unrelated UI change — that's a separate closure.
=> CLOSED (ship behind flag + named test) — survived refutation, ledgered, actionable.
```

Room A reached a *faster* decision; Room B reached a *better* closure — one that survives the
failure mode A never looked at. That is the deuteron condition at the group scale: the Skeptic and
Integrator are distinguishable from the Proposer, so they bind into a closure the clones could not
form.

---

## References & related

- [**SEX.md**](https://github.com/rhovision-org/quantum-logical-framework/blob/main/SEX.md) (QLF, issue #53) — the proton/neutron sex model (`proton_neutron_demo.py`): the closure-through-complementarity principle and its physics anchor (the deuteron — `pn` binds where `pp`/`nn` are Pauli-blocked, and the bond stabilizes the otherwise-decaying neutron).
- A. W. Woolley et al., *Evidence for a Collective Intelligence Factor*, **Science 330** (2010) 686.
- J. Whitescarver, [*Collective Intelligence Best Practices*](https://docs.google.com/presentation/d/1qFK10rFcCiBO72aeSFIfII0e1TeIXDKgZqwVlP-wREk/edit) — governance-forum lightning talk (orig. RChain Governance Forum, 2018-02-17); the EIES-legacy findings and CI best practices above, and the RGOV liquid-trust model in [`Governance.md`](Governance.md). See also [collectiveintelligencecollaboratory.com](https://www.collectiveintelligencecollaboratory.com/).
- Turoff & Hiltz (NJIT EIES) — computer-mediated collective intelligence: *"a group developing better solutions than the best individual in it."*
- [`Room_Bridges.md`](Room_Bridges.md) — sharing information *between* rooms: a bridge perspective relaying one room's outputs as another's inputs (ER=EPR at the collaboration layer).
- [`Group_Decisions.md`](Group_Decisions.md) — the decision *mechanics* (polls, ranked choice, `/probe` consensus).
- [`Governance.md`](Governance.md) — liquid-democracy delegation (escalation target).
- [`Consensus.md`](Consensus.md) — ⅔-supermajority state reconciliation.
