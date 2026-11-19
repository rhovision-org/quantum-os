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
  memoryDistance,
  parseCandidates,
  ragArm,
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

// --- controller: verified commit -----------------------------------------
const proposal = JSON.stringify({
  candidates: [
    { id: "c1", question: "compute 2+2", distance: 1 },
    { id: "c2", question: "check units", distance: 2 },
  ],
});
const step = JSON.stringify({ evidence: "2+2=4", answer: "4", done: true });
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
ok("controller commits", controller.committed, controller.error ?? "");
ok("controller returns the verified answer", controller.answer === "4", String(controller.answer));
ok(
  "controller admits the relevant memory",
  controller.memoryAdmissions.map((m) => m.id).join(",") === "m1",
  JSON.stringify(controller.memoryAdmissions),
);
ok(
  "controller emits COMMIT last",
  controller.events.at(-1)?.kind === "COMMIT",
  JSON.stringify(controller.events),
);
ok("controller stays within its call budget", controller.budget.calls <= 4);
ok("controller does not call after commit", llm.calls.length === 2, String(llm.calls.length));

// --- controller: verifier rejection --------------------------------------
const rejected = await controllerArm({
  llm: mockLLM({ proposal, step: JSON.stringify({ evidence: "guess", answer: "4", done: true }) }),
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
