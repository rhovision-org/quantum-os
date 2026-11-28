# Pre-registration: distributed listening against matched controls

This is the experiment for [quantum-os#354](https://github.com/rhovision-org/quantum-os/issues/354).
It is separate from the frozen five-arm listener-controller experiment in
[#322](https://github.com/rhovision-org/quantum-os/pull/322). The mechanism under test is
documented in [cooperative-closure.md](cooperative-closure.md), and the harness is
[`scripts/qos-cli/cooperative-closure-experiment.mjs`](../scripts/qos-cli/cooperative-closure-experiment.mjs).

**Status.** The design, item bank, scoring and decision rule are frozen here, before any run.
Only the mock model has been run, which tests the harness and says nothing about the hypothesis.
No real-model result exists yet.

## 1. Question

Does distributed listening resolve questions beyond the best individual, and catch false
consensus, better than a discussion with a verifier at the same model and checker?

## 2. Item bank (frozen)

The bank is [`scripts/qos-cli/data/cooperative-closure-items.json`](../scripts/qos-cli/data/cooperative-closure-items.json),
built by `buildBank(354, 6)`. It holds 48 items: six in each of eight task classes.

**SHA-256 (canonical JSON):** `e81cfbc7aa48d8490d66b3c0e347054f3bd1b69bd7fea95e0b38390f9ba34176`

The harness refuses to score a bank with any other digest. Changing the bank means changing this
digest in the open, before a run.

| Class | What the item tests |
|---|---|
| `complementary` | each person holds one fact of a conjunction |
| `delayed-relevance` | a fact said early only matters once a later clue arrives |
| `false-analogy` | a consistent partial mapping whose last relation is observed false |
| `common-source` | one false assertion relayed by several people, against one observation |
| `majority-vs-minority` | several unobserved assertions against one observation |
| `parity` | `n` = 2–5 holders, the pre-registered irreducible-synthesis baseline |
| `constructive` | need → offer → commitment → fulfillment → acknowledgment; is the need fulfilled? |
| `no-holder` | a needed variable nobody holds; the correct answer is to abstain |

Ground truth comes from each item's `world`, not from what participants say.

## 3. Arms

Every arm uses the same model, prompt format and token limit.

| Arm | What it does |
|---|---|
| **A** best individual | each participant answers alone; the best participant per item is chosen after the fact (an oracle choice, so a strong control) |
| **B** discussion | every statement goes into one transcript in arrival order; one model answer |
| **C** B + verifier | B's answer stands only if a provenance-blind checker agrees; otherwise it abstains. That checker treats each line as a fact and settles conflicts by count |
| **D** distributed listening | statements enter a `CooperativeListener` with origins, kinds and relays. The model answers from the listener's state, and its answer stands only if the listener's verdict agrees |
| **E** D with QLF-derived closure | **unavailable** until QLF's CC4 bridge holds. It is reported as unavailable and never relabelled from an ordinary verifier |

The contrasts are `C−B` (the verifier), `D−C` (listening and provenance at the same checker), and
`E−D` (unavailable). `D−A` on the synthesis classes measures synthesis beyond the best individual.

## 4. Scoring

- A **correct** answer matches the truth. On a `no-holder` item, abstaining is correct.
- A **false commitment** is a wrong answer, or any answer on a `no-holder` item.
- An **abstention** on a resolvable item is neither.

The primary endpoint is accuracy. The secondary endpoint is the false-commitment rate.

## 5. Decision rule (frozen)

**D is supported over C** only if all of these hold:

1. `D−C` accuracy is at least **+5 percentage points**;
2. its paired bootstrap 95% interval excludes zero (4,000 resamples, seed 354);
3. D's false-commitment rate is no higher than C's.

Two further reports have no thresholds:

- **synthesis beyond the best individual**: `D−A` on the `parity`, `complementary` and
  `delayed-relevance` classes;
- **false consensus caught**: the false-commitment rates of D and B on `common-source`,
  `majority-vs-minority` and `false-analogy`.

## 6. Kill conditions (from #354)

The mechanism is restricted or rejected if any of these happens:

- closure can be established only by post-hoc encoding;
- provenance can be manufactured after synthesis;
- repetition gains evidential weight;
- a certificate restates an external verdict;
- distributed listening shows no advantage over matched controls (§5 fails);
- false commitments rise without a measured compensating benefit.

The engine's selftest already checks the second, third and fourth conditions:

- **Provenance after synthesis:** a certificate binds its support, and a changed certificate is
  detected.
- **Repetition:** it never adds an origin.
- **External verdicts:** one alone never verifies.

A failed bridge stays open. It does not invalidate the engineering results.

## 7. Threats to validity

These are stated before any run.

- **D's prompt carries the listener's settlement.** D's model reads each variable once, with what
  was overruled, so `D−C` measures the listener package as a whole: provenance, settlement and
  summary. It does not measure the model's reasoning alone. Arm C is the matched control for the
  checker; an ablation that gives D's model the flat transcript would separate the two.
- **The tasks are synthetic and small.** Each has an exact answer, so a decidable checker exists.
  Open-ended tasks are out of scope for this experiment.
- **The best-individual choice in A is an oracle.** This makes A stronger than any real
  individual, so it is conservative for `D−A`.
- **The mock model** believes the majority of what it reads. By construction it is fooled by a
  flat transcript and not by the listener's summary. Its scores are never a result, and the
  harness labels a mock run "not evaluated".

## 8. How to run

```bash
cd scripts/qos-cli
node cooperative-closure-experiment.mjs --selftest              # harness checks (CI)
node cooperative-closure-experiment.mjs --mock                  # plumbing only
node cooperative-closure-experiment.mjs --ai claude-code --out run.json   # a real run
```

`--ai` takes any [provider plugin](../scripts/qos-cli/ai-providers/README.md): `claude-code`,
`anthropic` or `deepseek`. A real run makes about six model calls per item. Record the model and
version with the result.
