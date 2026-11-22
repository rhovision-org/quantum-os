// listener-controller.selftest.mjs — offline controller tests.
//
// The mock LLM is deterministic and local. Real runs inject the existing
// QuantumOS Claude-backed advisor (makeAdvisor(...).complete); no API call is
// made here.
//
//   node scripts/qos-cli/listener-controller.selftest.mjs

import {
  Budget,
  admittedMemories,
  controllerArm,
  directArm,
  estimateTokens,
  listenerClosureArm,
  memoryDistance,
  parseCandidates,
  ragArm,
  ragClosureArm,
  retrieveMemories,
} from "./listener-controller.mjs";

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`);
  }
};

function mockLLM({ proposal = "", step = "", answer = "42" } = {}) {
  const calls = [];
  return {
    calls,
    lastError: null,
    async complete({ prompt = "" } = {}) {
      calls.push(prompt);
      if (prompt.includes("List 2-4 open candidate")) return proposal;
      if (prompt.includes("Work the candidate")) {
        return typeof step === "function" ? step(prompt) : step;
      }
      return answer;
    },
  };
}

const memories = [
  { id: "m1", text: "what is 2+2 arithmetic check" },
  { id: "m2", text: "cooking dinner with friends" },
];

// --- memory admission ------------------------------------------------------
ok("matching memory is admissible", memoryDistance(memories[0], "what is 2+2") === 0);
ok("unrelated memory is not admissible", memoryDistance(memories[1], "what is 2+2") > 0);
ok(
  "admission admits only the matching memory",
  admittedMemories(memories, "what is 2+2").map((m) => m.id).join(",") === "m1",
);
ok(
  "retrieval orders nearest first",
  retrieveMemories(memories, "what is 2+2", 2)[0].id === "m1",
);
ok("token estimate is positive", estimateTokens("hello world") > 0);

// --- baselines -------------------------------------------------------------
const direct = await directArm({
  llm: mockLLM({ answer: "4" }),
  task: "what is 2+2?",
  budget: new Budget({ maxCalls: 2 }),
});
ok("direct arm answers", direct.answer === "4" && direct.committed);
ok("direct arm uses one call", direct.budget.calls === 1, String(direct.budget.calls));

const rag = await ragArm({
  llm: mockLLM({ answer: "4" }),
  task: "what is 2+2?",
  memories,
  budget: new Budget({ maxCalls: 2 }),
  k: 1,
});
ok("rag arm answers", rag.answer === "4" && rag.committed);
ok("rag arm retrieves memory", rag.retrieved[0]?.id === "m1", JSON.stringify(rag.retrieved));

// --- C: RAG + closure gate, same verifier/retry ---------------------------
const step = JSON.stringify({ evidence: "2+2=4", answer: "4", done: true });
const c = await ragClosureArm({
  llm: mockLLM({ step }),
  task: "what is 2+2?",
  memories,
  budget: new Budget({ maxCalls: 4, maxTokens: 3000 }),
  k: 1,
  verifier: ({ evidence }) => ({ ok: evidence.some((line) => line.includes("2+2=4")) }),
});
ok("C arm is rag-closure", c.arm === "rag-closure", c.arm);
ok("C arm uses closure gate", c.closureGate === true);
ok("C arm commits through the verifier", c.committed && c.answer === "4");
ok("C arm retrieves conventional RAG context", c.retrieved[0]?.id === "m1");
ok("C arm does not use listener admission events", !c.events.some((e) => e.kind === "MEMORY_ADMIT"));

// --- D: listener + closure gate, one candidate ----------------------------
const d = await listenerClosureArm({
  llm: mockLLM({ step }),
  task: "what is 2+2?",
  memories,
  budget: new Budget({ maxCalls: 4, maxTokens: 3000 }),
  verifier: ({ evidence }) => ({ ok: evidence.some((line) => line.includes("2+2=4")) }),
});
ok("D arm is listener-closure", d.arm === "listener-closure", d.arm);
ok("D arm uses closure gate", d.closureGate === true);
ok("D arm commits through the verifier", d.committed && d.answer === "4");
ok("D arm admits the listener-relevant memory", d.memoryAdmissions.map((m) => m.id).join(",") === "m1");

// --- D: delayed relevance -------------------------------------------------
const delayedMemories = [
  { id: "m_delayed", text: "solve clue alpha" },
  { id: "m_distractor", text: "puzzle hint" },
];
const delayedStep = (prompt) => {
  if (prompt.includes("Admitted memories:\n- solve clue alpha")) {
    return JSON.stringify({ evidence: "memory confirms", answer: "solved", done: true });
  }
  return JSON.stringify({ evidence: "clue alpha", answer: "", done: false });
};
const delayed = await listenerClosureArm({
  llm: mockLLM({ step: delayedStep }),
  task: "solve puzzle",
  memories: delayedMemories,
  budget: new Budget({ maxCalls: 4, maxTokens: 3000 }),
  maxSteps: 3,
  verifier: ({ answer, memories: admitted }) => ({
    ok: answer === "solved" && admitted.some((memory) => memory.id === "m_delayed"),
    reason: "needs the delayed clue",
  }),
});
ok("delayed memory is admitted later", delayed.memoryAdmissions.some((m) => m.id === "m_delayed"));
ok("delayed arm commits", delayed.committed && delayed.answer === "solved");
const delayedAdmit = delayed.events.findIndex((e) => e.kind === "MEMORY_ADMIT" && e.id === "m_delayed");
const delayedCommit = delayed.events.findIndex((e) => e.kind === "COMMIT");
ok("delayed memory is admitted before commit", delayedAdmit >= 0 && delayedAdmit < delayedCommit);

// --- E: full controller (listener + multiple candidates) ------------------
const proposal = JSON.stringify({
  candidates: [
    { id: "c1", question: "compute 2+2", distance: 1 },
    { id: "c2", question: "check units", distance: 2 },
  ],
});
const llm = mockLLM({ proposal, step });
const controller = await controllerArm({
  llm,
  task: "what is 2+2?",
  memories,
  budget: new Budget({ maxCalls: 4, maxTokens: 3000 }),
  verifier: ({ evidence }) => ({
    ok: evidence.some((line) => line.includes("2+2=4")),
    reason: "needs the arithmetic check",
  }),
});
ok("E arm commits", controller.committed, controller.error ?? "");
ok("E arm returns the verified answer", controller.answer === "4", String(controller.answer));
ok(
  "E arm admits the relevant memory",
  controller.memoryAdmissions.map((m) => m.id).join(",") === "m1",
  JSON.stringify(controller.memoryAdmissions),
);
ok(
  "E arm emits COMMIT last",
  controller.events.at(-1)?.kind === "COMMIT",
  JSON.stringify(controller.events),
);
ok("E arm stays within its call budget", controller.budget.calls <= 4);
ok("E arm does not call after commit", llm.calls.length === 2, String(llm.calls.length));

// --- verifier rejection ----------------------------------------------------
const rejected = await listenerClosureArm({
  llm: mockLLM({ step: JSON.stringify({ evidence: "guess", answer: "4", done: true }) }),
  task: "what is 2+2?",
  memories,
  budget: new Budget({ maxCalls: 3 }),
  verifier: () => ({ ok: false, reason: "not independently checked" }),
});
ok("rejected answer is not committed", rejected.committed === false);
ok("rejection leaves no COMMIT", !rejected.events.some((event) => event.kind === "COMMIT"));
ok("rejection reports a reason", /no verified closure/.test(rejected.error ?? ""), rejected.error);

// --- budget and parsing ----------------------------------------------------
const tiny = await controllerArm({
  llm: mockLLM({ proposal }),
  task: "what is 2+2?",
  memories,
  budget: new Budget({ maxCalls: 1 }),
  verifier: () => ({ ok: true }),
});
ok("budget exhaustion prevents a commit", tiny.committed === false);
ok("budget exhaustion respects one call", tiny.budget.calls === 1, String(tiny.budget.calls));

const fallback = parseCandidates("not json", "fallback task");
ok("invalid candidate JSON falls back", fallback.length === 1 && fallback[0].question === "fallback task");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: listener-controller.selftest.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
