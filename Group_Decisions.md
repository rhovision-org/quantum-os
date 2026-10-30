# Group Decisions in [QuantumOS](README.md)

How a group decides things — vote on lunch, agree a fact, swap resources, pick a
moderator — using QuantumOS's existing peer-to-peer primitives, plus a sketch of
the decision processes the same substrate can grow into.

This is a vision/map doc. For the built poll mechanics see `CLAUDE.md` (the
*Group polls* section); for the consensus probe see [`Consensus.md`](Consensus.md).
For the *composition and closure-quality* side — room roles, the closure checklist, and how a
room reaches a good decision without groupthink — see [`Room_Best_Practices.md`](Room_Best_Practices.md).
To chain these tools into an annealing loop and *optimize* (not just decide), see
[`Collective_Optimization.md`](Collective_Optimization.md).

Every process below — poll, estimate, probe, rendezvous, channel, lemma — is
**verified peer-to-peer with no blockchain in the loop**: the tally is a pure,
deterministic function every peer computes locally from the signed envelopes it
holds. A group's decision is never written to a public ledger and never costs
gas; a chain only enters if the group deliberately wants an on-chain record of
the outcome (e.g. `/gov uri`), which is a separate, opt-in step.

---

## Why this works without a server

QuantumOS has no central authority to count votes, hold a tally, or declare a
winner. Every decision process here is the same two ingredients:

- **Dyncap-signed envelopes** — each contribution (a ballot, a nomination, an
  acceptance) is a hash-chained message attributable to a peer. You cannot forge
  another peer's signed contribution, and a fork (two messages at the same
  sequence) is flagged.
- **A deterministic, joiner-local tally** — every peer recomputes the outcome
  from the contributions it holds. Same inputs → same result on every machine, so
  the group converges on one answer without anyone being trusted to count.

Possessing the room capability token **is** the franchise: if you're in the room,
you can take part. The trust model is *advisory / best-effort* throughout — the
same model as `/pass`. A peer can refuse to relay, or go offline; it cannot lie
about what others said. Gossiped state (polls, lemmas) re-syncs to late joiners
via the `sync-*` handshake, so the room self-heals.

---

## The map

| Process | What it's for | Primitive | Status |
|---|---|---|---|
| Approval vote | "Which of these are acceptable?" | `/poll` | **Built** |
| Ranked-choice (IRV) | Pick one winner without vote-splitting | `/poll … ranked` | **Built** |
| Collect-then-decide | Crowd the options, then vote | `/poll new` (open nominations) | **Built** |
| Robust group estimate | A whale-resistant median of numeric estimates | `/estimate` (median/IQR) | **Built** |
| Consensus reconciliation | Agree shared state by ⅔ supermajority | `/probe` | **Built** |
| Atomic multiparty agreement | All-or-nothing commit across N peers | `/rdv` | **Built** |
| Deliberation threads | Discuss a topic before deciding | `/channel` | **Built** |
| Decision of record | Mint the agreed outcome as a shareable token | `/lemma` (+ `/persist`) | **Built** |
| Delegation (liquid) | Your vote flows to your delegate unless you vote | `/gov delegate` (transitive, weighted) | **Built** — [Governance.md](Governance.md) |
| Weighted / liquid trust | Votes weighted by earned trust, in an admin-rooted hierarchy | `/gov trust` (level = `1+`weight) | **Built** — [Governance.md](Governance.md) |
| Accountability / censure | A ⅔ quorum discredits undeserved trust + slashes vouchers | `/gov censure` | **Built** — [Governance.md](Governance.md) |
| Quorum / threshold | Bind only if enough vote / a bar is cleared | extend `/poll` | Sketch |
| Quadratic / budget | Spread voice-credits across options | `/note` conservation | Sketch |
| Sortition / lottery | Pick fairly at random | `/cap` (ZFA-random) | Sketch |
| Consent / objection | Passes unless someone objects | poll + veto semantics | Sketch |
| Conviction voting | Support strengthens the longer it's held | timed ballot weight | Sketch |

---

## Built today

### Approval voting — `/poll`
Each member taps every option they'd be happy with; the option with the most
approvals wins. Robust for "where do we eat?" — nobody is forced to pick just one,
so a broadly-liked compromise surfaces.

```
/poll new What's for lunch? | pizza, burgers, salad
```

### Ranked-choice / IRV — `/poll … ranked`
Members rank options in preference order; instant-runoff eliminates the lowest and
redistributes until one option holds a majority of continuing ballots. Resolves a
three-way split that a plurality vote would mishandle. Elimination ties break
deterministically (smallest option id) so every peer agrees.

```
/poll new Best venue? | a, b, c ranked
```

### Collect-then-decide (open nominations)
Open a poll with **no** fixed options; anyone adds candidates (the card's
"add an option" box or `/poll add`), everyone votes and re-votes live, and the
creator closes it. Options are keyed by a content hash, so identical suggestions
auto-merge and ballots never get scrambled by broadcast ordering.

```
/poll new What should we name it?      # then the group adds + votes
```

### Robust group estimate — `/estimate`
Open a numeric estimate round (`/estimate new How many story points?`); each peer
submits a number (`/estimate 8`) and the round reports a **median** (whale- and
outlier-resistant) with the inter-quartile range — `--mean` for the mean. Mesh-
synced one round at a time, the same deterministic joiner-local pattern as polls.
Used inside the governance and collaborative-study macros (`RhoQuCalc_Macros.md`).

### Consensus reconciliation — `/probe`
When a peer joins, it samples what others hold for shared state (lemmas,
currencies) and adopts the **dyncap-weighted ⅔ supermajority** value, ignoring
peers that lost. This is agreement-on-facts rather than a vote on a question — the
mechanism that keeps the room's shared vocabulary consistent. See
[`Consensus.md`](Consensus.md).

### Atomic multiparty agreement — `/rdv`
N-party rendezvous: a proposer collects acceptances and **nobody commits unless
everyone accepts**; `conservationCheck` enforces that what's given equals what's
received across the whole circle. Use it for resource swaps, shift/seat exchanges,
or a multisig-style "we all sign or none of us does" commit. Locks release on
abort/reject/timeout, so a stalled deal never traps value.

### Deliberation threads — `/channel`
Tagged broadcast channels let a group hold parallel topic threads
(`/channel listen lunch`, `/channel send lunch …`) to discuss before — or
alongside — a poll.

### Decision of record — `/lemma` (+ `/persist`)
Once decided, mint the outcome as a named **lemma**: an immutable, ZFA-balanced
capability token that any peer can reference by `@name` and that new joiners
inherit. `/persist` agrees its cross-peer replication. This turns an ephemeral
vote into a durable, citable decision artifact.

---

## Natural next steps

Each maps onto an existing primitive — sketches, not yet built.

- **Quorum / threshold polls.** Give a poll a close rule: "binds only at ≥N
  ballots" or "passes at a ⅔ bar." Reuse the probe's supermajority constants
  (`SUPERMAJORITY_NUM/DEN`) so the threshold semantics match the rest of the system.

- **Weighted / liquid-trust voting — built.** `/gov trust <member> <0–5>` confers
  a trust level *strictly below the rater's own* in an admin-rooted web of trust;
  a member's vote weight becomes `1 + level`, flowing through the same delegation
  tally. **`/gov censure`** adds accountability — a ⅔ quorum of eligible peers
  (even over an admin) discredits a member holding undeserved trust and slashes
  everyone who vouched for them. With no ratings it stays one-person-one-vote. See
  **[Governance.md](Governance.md)**.

- **Quadratic / budget voting.** `/note` already enforces conservation
  (`count_pos == count_neg`) on split/merge. Issue each voter a fixed budget of
  voice-credit notes and let them spend across options; cost-to-influence is the
  natural quadratic lever, with conservation preventing credit inflation.

- **Delegation / liquid democracy — built.** `/gov` adds groups, members, issues,
  and **standing, revocable, transitive delegation**: if you don't vote on an
  issue, your weight flows to your delegate (and onward), feeding a weighted
  approval/ranked tally. This is the rgov governance model on quantum-os
  primitives — see **[Governance.md](Governance.md)**.

- **Sortition / fair lottery.** `/cap` mints ZFA-random tokens. Seed a public draw
  from a token every participant can verify, to select a moderator, a sample jury,
  or a tie-breaker without trusting a coordinator.

- **Consent / objection (sociocracy).** Invert the default: a proposal **passes
  unless someone objects** within a window. Reuse `rdv-reject`-style veto
  semantics layered over a poll — good for fast, low-stakes group sign-off.

- **Conviction voting.** Let a ballot's weight grow the longer it's held, so
  steady long-term support outweighs a last-minute swing. Builds on the same
  timed/weighted-ballot machinery as reputation voting.

- **Composing them into protocols (macros).** These primitives are the building
  blocks; a *guided multi-phase protocol* (a 9-stage governance loop, a
  required-dissent closure room, a collaborative study session) is a **macro** that
  sequences them. A macro is best expressed as a verified ρ-process
  (`action`/`lift`/`sequence`/`parallel`/`dagger`), so it inherits ZFA
  well-formedness, reflection, and capability security by construction — see
  **[RhoQuCalc_Macros.md](RhoQuCalc_Macros.md)** for the `/command`↔constructor
  mapping and three worked protocols.

---

## Trust & decentralization notes

- **Deterministic convergence.** Tallies are pure functions of the signed
  contributions, recomputed independently by each peer — there is no authoritative
  counter to capture or bribe.
- **What a malicious peer can do:** withhold relay, go offline, or decline to
  participate; a re-vote (latest ballot wins) is legitimate, not an attack.
- **What it cannot do:** forge another peer's signed ballot, or replay/rewrite the
  chain without raising a dyncap fork warning. Double-identity ("sybil") pressure
  is bounded by the dyncap chain model, not eliminated — weight by standing where
  that matters.
- **Best-effort by design.** Like `/pass`, these are social-trust protocols with
  cryptographic attribution, not Byzantine-fault-tolerant consensus. They're built
  for cooperating groups that want structure and a clear record, not for
  adversarial settlement.

---

## Housekeeping

Decision state lives in per-room `localStorage` (`qos-polls-<roomId>`,
`qos-lemmas-<roomId>`, `qos-chat-<roomId>`, …) and replays into the UI on reload
and tab-switch.

**Removal & retraction** is implemented: a sidebar ✕ on each poll/lemma/note, a
remove button on poll cards, and a `/forget <poll <id> | lemma <name> | note …>`
command. Because gossiped state (polls, lemmas) otherwise heals back from the
next peer's `sync-*`, removal uses **tombstones** (`qos-retracted-<roomId>`): the
owner broadcasts a dyncap-signed `retract` everyone honors (creator for a poll,
author for a lemma), and anyone else hides the item from their own view. Notes are
private bearer value, so `/forget note` deletes locally with a confirm.
(Transfer-as-removal still applies too: `/pass`, `/note` ops, `/probe clear`, the
chat-log cap.) The headless **memory-peer daemon** honors author lemma retractions
as well, so an always-on peer won't resurrect a removed lemma.

---

## See also

- **[RhoGov process orchestration](https://github.com/rhovision-org/rhogov/blob/main/docs/process-orchestration.md)** — how these decision processes become reusable components of on-chain councils for rholo governance: instruments, combiners, trust gates that move a decision's phases on by themselves, and process templates.
- **[QuantumOS README](README.md)** — the runtime these decision processes run on: rooms, peers, capability tokens, slash commands, and the ZFA substrate.
- **[Quantum Logical Framework (QLF) README](https://github.com/rchain-community/quantum-logical-framework/blob/main/README.md)** — the physics/formalism repo: ZFA closure, the machine-verified Lean proofs, and the collective-intelligence theory ([`Room_Best_Practices.md`](Room_Best_Practices.md)) behind reaching good group closure.
