# Listener controller: closure-gated reasoning around the QuantumOS agent

**Status:** first slice. Offline selftest only; no claim of improved reasoning and no API calls in
CI. The real generator is the **existing Claude-backed QuantumOS advisor**
(`facilitator-advisor.mjs`), not a new model client.

---

## 0. The point

The LLM remains the generative engine. The controller supplies the cognitive control state:

```
prompt
  → open candidates
  → listener context + admitted memory
  → nearest unresolved candidate
  → evidence step
  → independent verifier
  → atomic COMMIT
  → answer
```

Two corrections to ordinary chain-of-thought:

1. **Do not commit because the model emitted an answer.** Commit only when a declared verifier
   accepts it.
2. **Do not admit every similar memory.** A memory enters the active listener only when its
   listener-relative distance reaches zero.

This is an implementation of the listener/closure architecture, not a claim that an LLM has
feelings or that QLF explains its weights.

---

## 1. Reuse the existing Claude agent

QuantumOS already has the model path:

- `scripts/qos-cli/facilitator-advisor.mjs` — `makeAdvisor({ ai, backend, model })`;
- backends: `api` (Anthropic Messages API, `ANTHROPIC_API_KEY`) and `claude-code` (the local
  `claude` CLI, using the existing Claude login);
- `scripts/qos-cli/agent.mjs` — the room agent that calls `advisor.advise(...)`.

This PR adds a generic `complete({ system, prompt, maxTokens })` method to the same advisor. It uses
the same backend, model, timeout, and error reporting, but no room-specific prompt, token cap, or
`NONE` filtering. The controller injects that method:

```js
const advisor = makeAdvisor({ ai: true, backend: "claude-code" });
const result = await controllerArm({
  llm: advisor,
  task,
  memories,
  verifier,
  budget: new Budget({ maxCalls: 6, maxTokens: 3000 }),
});
```

There is no second Claude client. The mock in the selftest exists only so controller mechanics can
be tested without an API key, a Claude login, or stochastic model output.

---

## 2. Controller contract

`scripts/qos-cli/listener-controller.mjs` exports:

- `Budget` — call and approximate token budget;
- `memoryDistance(memory, listenerText)` — generic feature-overlap distance; zero = admissible;
- `retrieveMemories` / `admittedMemories` — conventional top-k retrieval vs listener-triggered
  admission;
- `directArm`, `ragArm`, `ragClosureArm`, `listenerClosureArm`, `controllerArm`;
- `parseCandidates`, `parseStep` — strict JSON parsing with a deterministic fallback.

`closureArm` (behind C/D/E):

1. uses one candidate (C/D) or asks for 2–4 open candidates (E);
2. selects the nearest eligible candidate;
3. uses conventional top-k context (C) or admits only memories whose distance is zero (D/E);
4. asks for one evidence/answer step;
5. calls the **independent verifier**;
6. emits `COMMIT` only when the verifier returns `{ ok: true }`.

The LLM's `done: true` is not enough. A rejected answer produces `VERIFY_FAIL` and remains open for
the next step under the same budget.

The listener context includes evidence accumulated so far, so a memory that was irrelevant at `B_0`
can become admissible only after a later clue.

---

## 3. Five arms, factorial contrasts

The earlier three-arm design could show that the whole controller package helps. It could not show
which mechanism caused the gain. The frozen design is:

| arm | retrieval | candidates | commit rule |
|---|---|---|---|
| **A direct** | none | one | model answer |
| **B RAG** | conventional top-k | one | model answer |
| **C RAG + closure** | conventional top-k | one | **same verifier/retry as D/E** |
| **D listener + closure** | listener-triggered admission | one | **same verifier/retry as C/E** |
| **E full controller** | listener-triggered admission | multiple, distance-scheduled | **same verifier/retry as C/D** |

The factorial questions:

```
C − B : does closure-gating help beyond ordinary RAG?
D − C : does listener-triggered recollection add anything beyond the same gate?
E − D : do multiple open candidates and distance scheduling add anything beyond D?
```

The strongest QLF-specific result is **D > C** at matched model, verifier, retry budget, token/call
budget, and memory corpus. That isolates listener-relative admission rather than the whole package.

A/B intentionally have no closure gate; they are the no-gate baselines. C/D/E use the same verifier
and retry allowance. The controller's extra calls count against the same cap.

### Frozen design parameters

These are fixed before any scoring:

- `k = 3`;
- `maxCalls = 6`, `maxTokens = 3000`, `maxSteps = 4` for A–E;
- temperature `0`, or the lowest deterministic setting the provider exposes;
- 3 repeated seeds per task;
- same model/version, task set, prompt format, retrieval corpus, and verifier per task;
- listener distance rule frozen as `max(0, 3 − |tokens(memory) ∩ tokens(listener)|)`;
- primary endpoint `Q = verified correct tasks / (tokens or calls)`;
- practical threshold: **+5 percentage points absolute over the best control at matched budget cap**,
  with a paired 95% confidence interval excluding zero. A power pilot on a disjoint item bank may
  increase `N`; it may not change the threshold.

This document freezes the **design**, not the final item bank. The exact tasks and verifiers must be
committed in a separate manifest before any scores are collected. No `memoryDistance` tuning after
seeing which memories should have been recalled.

### Required delayed-relevance subset

Include tasks where an early memory is irrelevant to the initial prompt but becomes decisive after a
later clue changes the listener:

```
d(M_i | B_0) > 0
later clue → d(M_i | B_t) = 0 → MEMORY_ADMIT(M_i)
```

This is the distinctive prediction. Ordinary recency windows should miss it; a listener controller
should recall it at the later step. The offline selftest now exercises this path.

### Task mix

The main benchmark must include long-range memory, contradiction resolution, multi-step reasoning,
coding with executable tests, source-grounded research, and formal/logical reasoning, plus easy tasks
where extra reasoning should not help. A QLF-repository benchmark may be included as a secondary
development set, but not as the sole benchmark.

---

## 4. Metrics and decision rule

Primary endpoint:

```
Q = verified correct tasks / (tokens or calls)
```

Report both denominators; an architecture that buys accuracy with disproportionate inference is not
an unqualified improvement.

Secondary metrics:

- final-task accuracy;
- hallucination / unsupported-claim rate;
- contradiction rate;
- successful long-range recall;
- irrelevant-memory injection rate;
- erroneous-memory replay rate;
- calibration;
- number of premature answers;
- how often the skeptic reverses an initially favored answer;
- tokens, tool calls, and wall-clock time;
- performance after long histories.

### Decomposition rule

- If **C > B**, closure-gating helps beyond ordinary RAG.
- If **D > C**, listener-triggered recollection adds value beyond the same gate.
- If **E > D**, multiple open candidates and distance scheduling add value beyond D.
- If C, D, and E are indistinguishable, the gain is ordinary verification/reasoning, not a
  QLF-specific mechanism.
- If a simpler verifier matches the controller at lower cost, use the simpler verifier.

The strongest falsifier:

> **If QLF closure does not outperform the strongest conventional reasoning/verification control at
> matched budget, or if its advantage disappears after controlling for additional inference, we do
> not claim that QLF closure improves LLM intelligence.**

A positive whole-package result (`E > A`) is not enough. The mechanistic claim requires
**D > C** at matched model, verifier, retry, token/call budget, and memory corpus.

---

## 5. What this slice does not do

- No API call in the selftest.
- No claim that reasoning improves.
- No generic natural-language verifier. Each task needs a declared closure predicate:
  arithmetic recomputation, tests, source/contradiction checks, or a formal status gate.
- A/B are intentionally no-gate baselines; C/D/E share the gate. The comparison `C − B` measures the
  gate, `D − C` measures listener-triggered memory, and `E − D` measures multi-candidate scheduling.
- The design is frozen here, but the item bank and per-task verifiers are not yet committed. **PR #322
  stays draft until that manifest is frozen and reviewed before any scores are collected.**
- No replacement of `agent.mjs` or the room advisor. The standalone controller is first; a
  `--reason`/`/reason` room mode is a later integration.
- No training and no transformer change.

---

## 6. Run it with the existing Claude agent

Offline checks (no API, no login):

```bash
node --check scripts/qos-cli/listener-controller.mjs
node scripts/qos-cli/listener-controller.selftest.mjs
node scripts/qos-cli/facilitator-advisor.selftest.mjs
node scripts/qos-cli/listener-controller.cli.mjs --selftest
```

Real run, reusing the same advisor as the room agent:

```bash
for arm in direct rag rag-closure listener-closure controller; do
  node scripts/qos-cli/listener-controller.cli.mjs \
    --task "what is 2+2?" \
    --verify arithmetic \
    --backend claude-code \
    --memories memories.json \
    --max-calls 6 --max-tokens 3000 \
    --arm "$arm"
done
```

`--backend claude-code` uses the local `claude` CLI and the existing login; `--backend api` uses
`ANTHROPIC_API_KEY`. Use the same backend/model and the same `--max-calls`/`--max-tokens` for all five
arms. The closure arms' extra calls count against that budget.

The advisor selftest uses a temporary fake `claude` CLI; the controller selftest uses a
deterministic mock LLM. Neither makes an API call.

---

## 7. Next integration

After the controller mechanics are reviewed:

1. add a `--reason` mode to `agent.mjs` that injects the existing `advisor.complete`;
2. define task-specific verifiers (arithmetic, code tests, claim status);
3. freeze the item bank, memory corpus, prompts, and per-task verifiers in a manifest **before**
   collecting scores;
4. run the five-arm factorial (A–E) on the fixed task set with matched budget caps and seeds;
5. record negative results, not only wins.

The controller is useful only if it beats the strongest comparably budgeted control, and the
mechanistic claim specifically requires `D > C`. Until then, it is a disciplined harness, not an
improvement claim.
