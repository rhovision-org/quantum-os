# Cooperative closure: provenance, certificates and a cooperative listener

This is the Quantum-OS half of [quantum-os#354](https://github.com/rhovision-org/quantum-os/issues/354).
The QLF half, with the proofs, is
[quantum-logical-framework#337](https://github.com/rhovision-org/quantum-logical-framework/issues/337).
The code is [`packages/browser/src/cooperative-closure.js`](../packages/browser/src/cooperative-closure.js).
It is plain JS with no imports, so the browser and the Node agents load the same file. Run
`node packages/browser/src/cooperative-closure.js --selftest` to check it (CI runs this).

**Status.** The engine runs and passes the shared fixtures. Nothing in the room uses it yet:
there is no slash command and no agent wiring. The experiment that tests it has a frozen design
and a harness; see [cooperative-closure-experiment.md](cooperative-closure-experiment.md).

The target is **synthesis**: a question gets resolved that no participant, and no proper subset of
them, could resolve. Consensus is not the target.

## Four closures, kept apart

| Closure | Holds when | In Quantum-OS |
|---|---|---|
| **Social** | participants agree | a poll result, a lemma everyone accepted, endorsements |
| **Logical** | the stated obligations are met | a ZFA verdict (`/zfa-check`), a shared `/solve`, any recomputable check |
| **Empirical** | the claim survives independently specified observation | an observation, with its observer, in the claim's provenance |
| **Constructive** | a possibility is realized by action | need → offer → commitment → fulfillment → acknowledgment |

Each can hold while the others fail. Mass hysteria is social closure without empirical closure.

### What a shared `/solve` is, and is not

A room's shared `/solve` or `/search` result is **logical closure**: every peer computed the same
closure from the same algebra, with nobody to trust. That is a real and strong property. But it is
not evidence about the world. By QLF's CC0 (the consensus fallacy), agreement in a record with no
observation in it is the same in every world, so it carries no information. It becomes evidence
only when an observation is in its provenance.

So "truth divination" and "truth is what closes" in the `/search` docs mean QLF's own technical
sense: a closure receipt, not a standing proposition. A closure receipt is a logical verdict, never
an empirical finding.

The QLF bridge that would make a room result **QLF-derived** is CC4: an encoding of a cooperative
history into a QLF history, fixed before any verdict is seen. That bridge is open. Until it holds,
Quantum-OS results are QLF-inspired verification. In the code, `QLF_CC4_AVAILABLE` is `false` and
every certificate reports `qlfDerived: false`.

## The parts

### Provenance graph (QOS3, CC3)

`ProvenanceGraph` is append-only. Every contribution names its **origin** and the earlier
contributions it cites. Only already-recorded ids can be cited, so the graph is acyclic by
construction, and nobody can back-fill support after a verdict.

There are four node kinds:

- **observation** — the origin observed something. This is the only kind that carries empirical
  support.
- **assertion** — the origin claims something without an observation.
- **relay** — the origin passes on what it cites. It adds **no** origin of its own.
- **derivation** — the origin computed something from what it cites.

`originsOf` follows CC3, provenance conservation. Repeating, duplicating, replaying or copying a
contribution changes neither its origins nor its observational support. Separate provenance is
not statistical independence, so the graph reports origins and never claims independence.

### Closure certificates and their lifecycle (QOS4–5)

`sealCertificate` binds four things:

- the claim and its scope;
- typed warrants, each with an outcome;
- the support it was sealed on;
- from the graph at seal time, that support's origins and observing origins.

The certificate id is a content id over all of that. So adding support later makes a different
certificate. It can never quietly edit this one, and `certificateIntact` detects tampering. The id
names content; it is not a security digest. Authorship comes from the dyncap signature on the
envelope that carries a certificate.

A warrant says what kind of thing it is. They establish different things, so a certificate never
blurs them:

| Warrant | What it is |
|---|---|
| `algebraic-receipt` | a QLF/ZFA closure computed in the room |
| `recomputable-check` | a decidable checker anyone can rerun (CC9) |
| `lean-proof` | a named, pinned Lean theorem |
| `empirical-observation` | an independently specified observation |
| `social-commitment` | a participant agreeing, endorsing or promising |
| `constructive-step` | one step of need → … → acknowledgment |
| `external-verdict` | a Boolean another verifier returned |

`deriveState` computes the lifecycle state from the warrants and from what happened since. Nobody
sets it, so every peer derives the same state:

| State | When |
|---|---|
| `open` | no warrant yet |
| `candidate` | warrants that verify nothing: agreement, promises, an external verdict on its own |
| `formally-verified` | a passing receipt, check or Lean proof |
| `empirically-supported` | a passing observation, **with** an observing origin in the provenance |
| `constructively-fulfilled` | all five constructive steps |
| `rejected` | a failing check or observation, its own or an objection's |
| `undetermined` | not resolved within its budget, which does not mean impossible (CC8) |
| `superseded` | replaced by a later certificate |

It also reports which closures hold (`social`, `logical`, `empirical`, `constructive`) separately,
because a certificate can be formally verified and empirically unsupported at once.

### Anti-hysteria (QOS6)

`promotionCheck` decides whether a certificate may enter the room's durable knowledge, such as a
lemma or a decision of record. It refuses:

- **circular corroboration**, where the claim appears in its own support's ancestry;
- **popularity**: endorsements are social commitments and never count as origins, so a hundred
  endorsements of one source are one origin;
- a certificate that is rejected, or only social, or changed after sealing.

Objections are never deleted. An objection carrying a failing observation or check rejects the
certificate, however many agree with it. An objection without evidence stays on record, marks the
certificate contested, and rides along with any promotion.

### Synthesis checks (CC2/CC6)

`consistentAnswers(question, holdings, coalition)` enumerates every assignment of the variables
nobody in the coalition holds. One possible answer means the coalition resolves the question; two
or more mean it stays blind. `minimalResolvingCoalitions` lists the smallest coalitions that
resolve it.

For parity of `n` bits, the only minimal coalition is all `n` holders. Resolution depends on
**which variables are held**, not on how many members hold them, so an echo chamber resolves
nothing a single member couldn't, and an irrelevant member adds nothing.

`substrateWitness(n, closes)` builds #354's witness: `n` parties each holding `^`, plus one holding
`v`×`n`. Together they close, and no nonempty proper sub-coalition does.

### The cooperative listener (QOS0–1)

`CooperativeListener` holds obligations open across time and takes contributions whenever they
arrive:

- **Persistent obligations.** `toJSON` / `fromJSON` round-trip, so obligations and contributions
  survive a restart.
- **Asynchronous contributions.** Each one is recorded in the provenance graph with its origin and
  kind. A relay is recorded as a relay.
- **Delayed relevance.** An obligation can make a variable matter only after a clue
  (`needsWhen: {x2: {ifVar: "x0", equals: 1}}`). A contribution that nothing needs yet is
  **held**, and it is admitted when a later clue makes it relevant.
- **Repetition never counts.** The same origin saying the same thing twice is one contribution,
  and relays of it add no origin.
- **Evidence outranks popularity.** Conflicting values are never settled by count. If exactly one
  value is backed by an observation and the others are only asserted, the observed value stands
  and the others stay on record as overruled. Otherwise the obligation stays **conflicted**, with
  the conflict on record.
- **A consistent partial answer is not acceptance.** An obligation stays open until the check
  resolves it. This follows the correction to CC1 on #354: a locally consistent branch can still
  fail to close.
- **Past its deadline, an obligation is undetermined**, never impossible (CC8).
- **The verdict is a recomputable check** over recorded contributions (CC9). `certify` seals it as
  a `recomputable-check` certificate.

QOS0–1 asks for this as an extension of the listener controller in
[#322](https://github.com/rhovision-org/quantum-os/pull/322), not as a new subsystem. #322 is still
a draft, so this listener is self-contained for now. The plan is to fold it in: its obligations
are the controller's open candidates, and `contribute` is the controller's memory admission with
provenance added.

## Shared fixtures

`runFixtures()` states each result #354 lists as proved in QLF as a check this module must pass.
QLF proves them in Lean (`QLF_CooperativeClosure`, `QLF_AnalogicalListener`). The selftest runs
them with its own ZFA predicate, and that predicate reproduces QLF's census at lengths 2 and 4.

| Fixture | Checks |
|---|---|
| CC0 | 50 relays of one assertion are one origin, stay a candidate and aren't promotable; one observation makes the claim empirically supported |
| CC3 | relays add no origin or observation; repeating yourself is one contribution |
| CC2 | parity of 2–5 bits: only all holders resolve it |
| CC6 | an echo chamber, an irrelevant member, an unheld variable, proper subsets stay blind |
| witness | `^`×n with `v`×n closes jointly, and no proper sub-coalition closes (n = 1–4) |
| CC1 | a consistent partial analogy leaves the obligation open, with no certificate |
| CC4 | nothing is labelled QLF-derived while the bridge is open |

## What is not built

- **No room surface yet.** There is no command that opens an obligation, and agents don't feed
  the listener. That is the next step.
- **Merge with #322's controller**, as described above.
- **The real experiment run**: see [cooperative-closure-experiment.md](cooperative-closure-experiment.md).
