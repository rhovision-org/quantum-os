# Where the quantum is: four ideas that make it work

QuantumOS, [rhogov](https://github.com/rhovision-org/rhogov) and the
[rholo](https://github.com/rhovision-org/rholo) node do what they do because of four ideas from the
[Quantum Logical Framework](https://github.com/rhovision-org/quantum-logical-framework) (QLF).
Separately each one is familiar. Together they explain why a room of browsers can
find agreement without a server, without trusting anyone, and without guessing.

1. **An a priori database of the possible.** Every admissible history already exists as a possibility.
2. **Native active inference.** Every closure is an act of inference worth exactly one bit.
3. **Strange loops, or reflection.** A system can read its own record, and that reading returns to the record.
4. **History selection.** Only the histories that close become events.

This page states each idea once, says where QLF proves or explains it, and names the code in each
repository that carries it. rhogov and rholo link here rather than restating it.

---

## 1. An a priori database of the possible

QLF is *possibilist*: "All logically admissible histories exist *a priori* as pure possibility"
([Philosophy.md §3](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Philosophy.md#3-possibilism-all-possible-logical-systems-exist-a-priori)).
The eight twists generate every history, and the **census**, the exact count of which histories close
at each length, is that database written down. Nothing is invented, because everything that can close
is already in it. Probability is a count of ways, not a primitive: a closure's frequency is its
multiplicity in the census ([Information_Physics.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Information_Physics.md)).

**In quantum-os.**
- [`crates/zfa-core/tests/census_conformance.rs`](../crates/zfa-core/tests/census_conformance.rs) re-derives QLF's census
  ([`census_inventory.json`](../crates/zfa-core/tests/data/census_inventory.json)) by brute force from this
  crate's own fold on every `cargo test`, so the database the room uses is the one QLF counted.
- `/search` asks the database a question, namely which histories close from here. It does not
  compute an answer that wasn't there. "The search is the experiment"
  ([QucalcSearch.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QucalcSearch.md)), and it runs in
  the browser (`qucalc-enum.ts`), so every peer reads the same database.

## 2. Native active inference

In QLF, active inference is the substrate's own rule, not a model added on top. Every closure is a
Markov-blanket agent resolving one binary distinction. Its two orderings, `t·t†` and `t†·t`, are
equally many, so the prior is fair with nothing to set it. The closure realises one ordering, so the
outcome is decisive. Two Lean results meet at that point:

- **Free energy.** `zfa_closure_minimizes_free_energy` gives ΔF = −log 2 per half-spin closure
  ([`QLF_FreeEnergy.lean`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_FreeEnergy.lean)).
- **Bayesian inference.** One binary observation is worth at most log 2 on average (`eig_le_log_two`),
  and exactly log 2 only when the prior is fair and the outcome decisive (`eig_eq_log_two_iff`). That is
  the closure's case, so the closure is the *optimal* Bayesian update, not merely one of them
  ([`QLF_MrEUpdate.lean`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_MrEUpdate.lean),
  [MrE_Update.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/MrE_Update.md)).

That one bit is *the quantum*: the closure is the unique event shape that both closes and extracts the
most information a single distinction can carry
([MRE.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/MRE.md)).

**In quantum-os.**
- Every capability token, lemma cap and room id is a closure, checked by `achieves_zfa` in
  `crates/zfa-core` and `zfa.ts`.
- A room is one distributed synthesis whose peers are Markov-blanket sub-agents
  ([QLF_as_Intelligence.md §8](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QLF_as_Intelligence.md)).
- **For people, the bit is a ceiling to aim for, not a guarantee.** A yes/no question settled in a room
  resolves at most one bit on average, and exactly one when the room was evenly split and the answer
  decisive. A surprising answer can move belief further than one bit (`pointwise_bound_false`), but
  the average cannot exceed the bound. So good facilitation asks the questions closest to 50/50 and
  closes them cleanly. The chair, `/poll` and `/lemma` exist for that
  ([Collective_Optimization.md](../Collective_Optimization.md)).

## 3. Strange loops, or reflection

A strange loop is a level-crossing self-reference that returns to its own record. QLF uses it for the
observer's self-model: "a finite Markov blanket modeling itself, its environment, and their
interaction". The loop runs in the reversible possibility algebra, not as a closed causal curve in
realised history ([Philosophy.md §3d](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Philosophy.md#3d-only-logic-is-assumed--and-time-loops-live-in-possibility)).
QLF also *is* one: its proofs are checked in Lean, and the substrate then re-derives the mathematics Lean
is built from. QLF's discipline is that a loop must **return conservatively to a finite record**.
Otherwise it is circular, or it is a one-way bridge passing itself off as a loop
([Strange_Loops.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Strange_Loops.md)).

**In quantum-os.** The room reflects on itself, and each reflection lands back in a finite record.
- `/search` saves each event it discovers as an integer-named room lemma (`@1`, `@2`, …). The next search
  finds those already named, so the room's lemma store *is* its closure cache.
- The skeptic agent reads the room's own claims against the census and flags any history that passes the
  room's predicate but fails QLF's.
- A chaired deliberation ends in a decision-of-record receipt that the room can `/lemma`.
- `/render` shows the room its own perspectives, closures and groups.

## 4. History selection

Of everything possible, only the histories that achieve Zero Free Action become events. All the rest
remain possibility. In QLF's reading, selection is "one negation … realized *only if it closes*", a
distinction that met its affirmation and cancelled
([Philosophy.md §3](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Philosophy.md#3-possibilism-all-possible-logical-systems-exist-a-priori)).
ZFA is the sole selection principle.

**In quantum-os.**
- Every token, room and lemma cap passes the ZFA gate or is not a capability at all.
- `/solve` selects the *one* closure the substrate takes from a position, by a deterministic cascade
  (least peak excursion, then shortest, then phase, then lexicographic), so every peer selects the same
  history with no service and nothing to trust.
- A room selects its own history with `/poll`, the consensus probe, `/lemma` and a chaired closure. Each
  is deterministic and joiner-local: every peer recomputes the same selection from the same signed inputs.

---

## The four together

The database holds every possibility. Selection keeps the ones that close. Each closure is an optimal
one-bit inference. Reflection lets a room read what it selected and build on it, and every loop
returns to a record anyone can recheck. That is the whole trick, and none of it is mysterious: QLF
calls it "the end of quantum magic", because probability becomes counting ways and agreement becomes
closure.

| Idea | QLF source | quantum-os | rhogov | rholo |
|---|---|---|---|---|
| A priori database of the possible | Philosophy.md §3, census, Information_Physics.md | `census_conformance.rs`, `/search` | the issue's options and every member's delegations and ratings, held as data in contracts | the tuplespace and registry hold names and processes; `rho:qucalc:zfa` checks membership in the closing set |
| Native active inference | `QLF_FreeEnergy.lean`, `QLF_MrEUpdate.lean`, MRE.md | every token is a closure; the room as one synthesis | standing, weights and outcomes computed by `rho:gov:*` natives, never by policy in a contract | `rho:qucalc:fuse`, dialectical synthesis as a native |
| Strange loops, reflection | Philosophy.md §3d, Strange_Loops.md | event lemmas, skeptic, decision receipts, `/render` | anyone recomputes standing from the chain's own record in one read-only query | the ρ-calculus is reflective: a name is a quoted process (`@P`), and a process is an unquoted name (`*x`) |
| History selection | ZFA as the sole selection principle | the ZFA gate, `/solve`, `/poll`, `/lemma` | the chain record is the group's selected history | consensus selects one block history; `rho:qucalc:grant`/`verify` persist a selected closure across deploys |

The rhogov and rholo columns are readings of mechanisms those repositories already ship. They are not
new claims about what those mechanisms do. The physics side of QLF has its own status register
([Claim_Status.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Claim_Status.md)).
Nothing on this page promotes a physical claim.
