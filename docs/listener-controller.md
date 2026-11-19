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
- `directArm`, `ragArm`, `controllerArm`;
- `parseCandidates`, `parseStep` — strict JSON parsing with a deterministic fallback.

`controllerArm`:

1. asks for 2–4 open candidates with an integer remaining distance;
2. selects the nearest eligible candidate;
3. admits only memories whose distance is zero;
4. asks for one evidence/answer step;
5. calls the **independent verifier**;
6. emits `COMMIT` only when the verifier returns `{ ok: true }`.

The LLM's `done: true` is not enough. A rejected answer produces `VERIFY_FAIL` and remains open.

---

## 3. Three arms, same budget

| arm | retrieval | control | commit rule |
|---|---|---|---|
| **A direct** | none | one answer call | model answer |
| **B RAG** | conventional top-k | one answer call | model answer |
| **C controller** | listener-triggered admission | multiple open candidates | verifier |

For a fair test:

- same model and version in all arms;
- same task set and prompt format;
- same retrieval corpus;
- same **call/token budget cap** (the controller's extra calls count against it);
- same verifier for arms A, B, and C where verification is part of the task;
- multiple seeds and a pre-registered stopping rule.

If the controller consumes more calls to reach the same answer, that is a cost, not a win.

---

## 4. Metrics

- final-task accuracy;
- hallucination / unsupported-claim rate;
- retrieved-memory precision;
- erroneous-memory replay rate;
- tokens and calls consumed;
- number of revisions;
- time to verified answer;
- performance after long histories.

The strongest falsifier:

> **If listener-triggered memory and verifier-gated closure do not outperform a comparably budgeted
> RAG/reasoning baseline — or merely consume more tokens to reach the same answers — the controller
> adds no useful mechanism.**

---

## 5. What this slice does not do

- No API call in the selftest.
- No claim that reasoning improves.
- No generic natural-language verifier. Each task needs a declared closure predicate:
  arithmetic recomputation, tests, source/contradiction checks, or a formal status gate.
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
node scripts/qos-cli/listener-controller.cli.mjs \
  --task "what is 2+2?" \
  --verify arithmetic \
  --backend claude-code \
  --arm controller
```

`--backend claude-code` uses the local `claude` CLI and the existing login; `--backend api` uses
`ANTHROPIC_API_KEY`. Use the same backend/model and the same `--max-calls`/`--max-tokens` for all
three arms. The controller's extra calls count against that budget.

The advisor selftest uses a temporary fake `claude` CLI; the controller selftest uses a
deterministic mock LLM. Neither makes an API call.

---

## 7. Next integration

After the controller mechanics are reviewed:

1. add a `--reason` mode to `agent.mjs` that injects the existing `advisor.complete`;
2. define task-specific verifiers (arithmetic, code tests, claim status);
3. run the three-arm experiment on a fixed task set with matched budgets;
4. record negative results, not only wins.

The controller is useful only if it beats a comparably budgeted RAG/reasoning baseline. Until then,
it is a disciplined harness, not an improvement claim.
