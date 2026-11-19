// listener-controller.mjs — listener-triggered memory and closure-gated reasoning
// around an existing LLM.
//
// The LLM is the generative engine.  This module owns the control state:
//   open candidates (questions/hypotheses)
//   listener context (task + admitted memory)
//   remaining distance d_i
//   a verifier-gated atomic COMMIT
//
// It is model-agnostic.  In QuantumOS, inject the existing Claude-backed
// advisor's generic `complete()`:
//
//   const advisor = makeAdvisor({ ai: true, backend: "claude-code" });
//   await controllerArm({ llm: advisor, ... });
//
// The selftest injects a deterministic mock; real runs use the same advisor as
// the room agent.  No API call is made by the selftest.

const DEFAULT_MAX_CALLS = 6;
const DEFAULT_MAX_TOKENS = 3000;

export class Budget {
  constructor({ maxCalls = DEFAULT_MAX_CALLS, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
    this.maxCalls = maxCalls;
    this.maxTokens = maxTokens;
    this.calls = 0;
    this.tokens = 0;
  }
  get remainingCalls() { return Math.max(0, this.maxCalls - this.calls); }
  get remainingTokens() { return Math.max(0, this.maxTokens - this.tokens); }
  canCall() { return this.calls < this.maxCalls && this.tokens < this.maxTokens; }
}

export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
}

/** Generic compatibility distance; zero means the memory is admissible now. */
export function memoryDistance(memory, listenerText) {
  const memoryTokens = new Set(tokenize(memory?.text ?? memory));
  const listenerTokens = new Set(tokenize(listenerText));
  let overlap = 0;
  for (const token of memoryTokens) if (listenerTokens.has(token)) overlap++;
  return Math.max(0, 3 - overlap);
}

export function retrieveMemories(memories, listenerText, k = 3) {
  return (memories ?? [])
    .map((memory) => ({
      ...memory,
      distance: memoryDistance(memory, listenerText),
    }))
    .sort((a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, k));
}

export function admittedMemories(memories, listenerText) {
  return retrieveMemories(memories, listenerText, (memories ?? []).length).filter(
    (memory) => memory.distance === 0,
  );
}

export function parseJsonObject(text) {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export function parseCandidates(text, fallbackTask) {
  const parsed = parseJsonObject(text);
  const raw = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const candidates = raw
    .map((candidate, index) => ({
      id: String(candidate?.id ?? `c${index + 1}`),
      question: String(candidate?.question ?? "").trim(),
      distance: Math.max(1, Math.floor(Number(candidate?.distance ?? 1))),
      evidence: [],
      committed: false,
    }))
    .filter((candidate) => candidate.question.length > 0);
  if (candidates.length) return candidates;
  return [
    {
      id: "c1",
      question: String(fallbackTask ?? "").trim(),
      distance: 1,
      evidence: [],
      committed: false,
    },
  ];
}

export function parseStep(text) {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  return {
    evidence: String(parsed.evidence ?? "").trim(),
    answer: String(parsed.answer ?? "").trim(),
    done: parsed.done === true,
  };
}

async function callLLM(llm, budget, { system = "", prompt = "", maxTokens = 256 } = {}) {
  if (!llm || typeof llm.complete !== "function") {
    return { text: null, error: "llm.complete is required" };
  }
  if (!budget.canCall()) return { text: null, error: "budget exhausted" };
  budget.calls += 1;
  const text = await llm.complete({ system, prompt, maxTokens });
  budget.tokens += estimateTokens(prompt) + estimateTokens(text);
  if (!text) return { text: null, error: llm.lastError ?? "llm returned no text" };
  return { text, error: null };
}

function answerPrompt(task) {
  return `Answer the task directly and concisely.\n\nTask: ${task}\n\nAnswer:`;
}

function ragPrompt(task, memories) {
  const lines = memories.map((memory) => `- ${memory.text}`).join("\n") || "(none)";
  return `Use the retrieved memories if they are relevant; ignore them if they are not.\n\nTask: ${task}\n\nRetrieved memories:\n${lines}\n\nAnswer:`;
}

const CANDIDATE_SYSTEM =
  "You are a reasoning controller. Return ONLY valid JSON, no prose.";
const STEP_SYSTEM =
  "You are working one open candidate. Return ONLY valid JSON, no prose.";

function candidatePrompt(task) {
  return `List 2-4 open candidate interpretations or subproblems. Each candidate has a short
question and an integer distance (remaining evidence/reasoning steps, at least 1).

Return exactly:
{"candidates":[{"id":"c1","question":"...","distance":1}]}

Task: ${task}`;
}

function stepPrompt(task, candidate, memories) {
  const lines = memories.map((memory) => `- ${memory.text}`).join("\n") || "(none)";
  return `Work the candidate. Return exactly:
{"evidence":"one new check or fact","answer":"candidate answer","done":true}

Set done=true only when the answer is ready for an independent verifier. The verifier,
not you, decides whether to commit.

Task: ${task}
Candidate: ${candidate.question}
Prior evidence: ${candidate.evidence.join(" | ") || "(none)"}
Admitted memories:
${lines}`;
}

export async function directArm({ llm, task, budget = new Budget() } = {}) {
  const call = await callLLM(llm, budget, {
    prompt: answerPrompt(task),
    maxTokens: 512,
  });
  return {
    arm: "direct",
    answer: call.text,
    committed: call.text !== null,
    error: call.error,
    budget,
    events: call.text ? [{ kind: "ANSWER" }] : [],
  };
}

export async function ragArm({
  llm,
  task,
  memories = [],
  budget = new Budget(),
  k = 3,
} = {}) {
  const retrieved = retrieveMemories(memories, task, k);
  const call = await callLLM(llm, budget, {
    prompt: ragPrompt(task, retrieved),
    maxTokens: 512,
  });
  return {
    arm: "rag",
    answer: call.text,
    committed: call.text !== null,
    error: call.error,
    retrieved,
    budget,
    events: call.text ? [{ kind: "ANSWER" }] : [],
  };
}

/**
 * Controller arm.
 *
 * `verifier({ candidate, answer, evidence, memories })` returns
 * `{ ok: boolean, reason?: string }`.  A COMMIT happens only when it returns ok.
 */
export async function controllerArm({
  llm,
  task,
  memories = [],
  verifier,
  budget = new Budget(),
  maxSteps = 6,
} = {}) {
  if (typeof verifier !== "function") throw new Error("verifier is required");
  const events = [];
  const admitted = new Map();

  const proposal = await callLLM(llm, budget, {
    system: CANDIDATE_SYSTEM,
    prompt: candidatePrompt(task),
    maxTokens: 400,
  });
  const candidates = parseCandidates(proposal.text, task);
  events.push({ kind: "CANDIDATES", ids: candidates.map((candidate) => candidate.id) });

  for (let step = 0; step < maxSteps && budget.canCall(); step += 1) {
    const open = candidates.filter((candidate) => !candidate.committed);
    if (!open.length) break;
    const next = open.reduce((a, b) =>
      a.distance < b.distance || (a.distance === b.distance && a.id < b.id) ? a : b,
    );

    const listenerText = `${task} ${next.question}`;
    const nearby = admittedMemories(memories, listenerText);
    for (const memory of nearby) {
      if (!admitted.has(memory.id)) {
        admitted.set(memory.id, memory);
        events.push({ kind: "MEMORY_ADMIT", id: memory.id, distance: 0 });
      }
    }

    const call = await callLLM(llm, budget, {
      system: STEP_SYSTEM,
      prompt: stepPrompt(task, next, [...admitted.values()]),
      maxTokens: 320,
    });
    const parsed = call.text ? parseStep(call.text) : null;
    if (!parsed) {
      next.distance = Math.max(1, next.distance);
      events.push({ kind: "STEP_FAIL", candidate: next.id, error: call.error ?? "unparseable" });
      continue;
    }

    if (parsed.evidence) next.evidence.push(parsed.evidence);
    if (parsed.done) {
      const verdict = verifier({
        candidate: next,
        answer: parsed.answer,
        evidence: next.evidence,
        memories: [...admitted.values()],
      });
      if (verdict?.ok) {
        next.committed = true;
        events.push({ kind: "COMMIT", candidate: next.id, answer: parsed.answer, tauEvent: 0 });
        return {
          arm: "controller",
          answer: parsed.answer,
          committed: true,
          candidate: next,
          events,
          memoryAdmissions: [...admitted.values()],
          budget,
          error: null,
        };
      }
      events.push({
        kind: "VERIFY_FAIL",
        candidate: next.id,
        reason: verdict?.reason ?? "verifier rejected",
      });
    } else {
      next.distance = Math.max(1, next.distance - (parsed.evidence ? 1 : 0));
      events.push({ kind: "EVIDENCE", candidate: next.id, distance: next.distance });
    }
  }

  return {
    arm: "controller",
    answer: null,
    committed: false,
    candidates,
    events,
    memoryAdmissions: [...admitted.values()],
    budget,
    error: "no verified closure within budget",
  };
}
