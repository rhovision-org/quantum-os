#!/usr/bin/env node
// listener-controller.cli.mjs — run the controller with the existing QOS advisor.
//
// Real runs reuse the same Claude-backed advisor as the room agent:
//   --backend claude-code  (local `claude` CLI / existing login)
//   --backend api          (ANTHROPIC_API_KEY)
//
// Examples:
//   node listener-controller.cli.mjs --task "what is 2+2?" --verify arithmetic \
//     --backend claude-code --arm controller
//
//   node listener-controller.cli.mjs --task "what is 2+2?" --verify arithmetic \
//     --backend claude-code --arm rag --memories memories.json
//
//   # C/D/E closure arms, same verifier and budget
//   node listener-controller.cli.mjs --task "what is 2+2?" --verify arithmetic \
//     --backend claude-code --arm rag-closure --memories memories.json
//   node listener-controller.cli.mjs --task "what is 2+2?" --verify arithmetic \
//     --backend claude-code --arm listener-closure --memories memories.json
//
// No API call is made by `--selftest`; that path uses a deterministic mock.

import fs from "node:fs";
import { makeAdvisor } from "./facilitator-advisor.mjs";
import {
  Budget,
  controllerArm,
  directArm,
  listenerClosureArm,
  ragArm,
  ragClosureArm,
} from "./listener-controller.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function arithmeticVerifier(task) {
  const match = String(task).match(/(-?\d+)\s*([+\-*/])\s*(-?\d+)/);
  if (!match) return null;
  const [, a, op, b] = match;
  const x = Number(a);
  const y = Number(b);
  const expected =
    op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : y === 0 ? null : x / y;
  if (expected === null) return null;
  return ({ answer }) => {
    const got = String(answer ?? "").replace(/[^0-9.\-]/g, "");
    return {
      ok: Number.isFinite(Number(got)) && Math.abs(Number(got) - expected) < 1e-9,
      reason: `expected ${expected}, got ${answer}`,
    };
  };
}

function makeVerifier(spec, task) {
  if (spec === "arithmetic") {
    const verifier = arithmeticVerifier(task);
    if (!verifier) throw new Error("--verify arithmetic needs a task like '12 * 3'");
    return verifier;
  }
  if (spec.startsWith("contains:")) {
    const needle = spec.slice("contains:".length);
    return ({ answer }) => ({
      ok: String(answer ?? "").includes(needle),
      reason: `answer must contain ${needle}`,
    });
  }
  if (spec === "nonempty") {
    return ({ answer }) => ({
      ok: Boolean(String(answer ?? "").trim()),
      reason: "empty answer",
    });
  }
  throw new Error(`unknown --verify ${spec}`);
}

function usage() {
  console.log(`Usage:
  node listener-controller.cli.mjs --task <text> [options]

Options:
  --arm direct|rag|rag-closure|listener-closure|controller
                                default: controller
  --backend claude-code|api     default: claude-code
  --model <name>                optional model override
  --verify arithmetic|nonempty|contains:<text>
                                default: nonempty
  --memories <json file>        array of {id,text}
  --max-calls <n>               default: 6
  --max-tokens <n>              default: 3000
  --selftest                    run the offline controller selftest
`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  usage();
  process.exit(0);
}

if (process.argv.includes("--selftest")) {
  await import("./listener-controller.selftest.mjs");
} else {
  const task = arg("--task");
  if (!task) {
    usage();
    process.exit(2);
  }
  const arm = arg("--arm", "controller");
  const arms = new Set(["direct", "rag", "rag-closure", "listener-closure", "controller"]);
  if (!arms.has(arm)) {
    console.error(`unknown --arm ${arm}`);
    usage();
    process.exit(2);
  }
  const backend = arg("--backend", "claude-code");
  const model = arg("--model", null);
  const verify = arg("--verify", "nonempty");
  const memoriesPath = arg("--memories", null);
  const memories = memoriesPath ? JSON.parse(fs.readFileSync(memoriesPath, "utf8")) : [];
  if (!Array.isArray(memories)) throw new Error("--memories must contain a JSON array");

  const advisor = makeAdvisor({
    ai: true,
    backend,
    model,
    log: (message) => console.error(message),
  });
  if (!advisor.enabled) {
    console.error(
      backend === "api"
        ? "advisor disabled: set ANTHROPIC_API_KEY for --backend api"
        : "advisor disabled: is the `claude` CLI installed and logged in?",
    );
    process.exit(2);
  }

  const budget = new Budget({
    maxCalls: Math.max(1, Number(arg("--max-calls", "6")) || 6),
    maxTokens: Math.max(1, Number(arg("--max-tokens", "3000")) || 3000),
  });
  const verifier = makeVerifier(verify, task);
  const common = { llm: advisor, task, memories, budget };
  const result =
    arm === "direct"
      ? await directArm(common)
      : arm === "rag"
        ? await ragArm(common)
        : arm === "rag-closure"
          ? await ragClosureArm({ ...common, verifier })
          : arm === "listener-closure"
            ? await listenerClosureArm({ ...common, verifier })
            : await controllerArm({ ...common, verifier });

  console.log(
    JSON.stringify(
      {
        arm: result.arm,
        closureGate: result.closureGate ?? false,
        memoryPolicy: result.memoryPolicy ?? null,
        multiCandidate: result.multiCandidate ?? false,
        committed: result.committed,
        answer: result.answer,
        events: result.events,
        retrieved: result.retrieved ?? [],
        memoryAdmissions: result.memoryAdmissions ?? [],
        budget: { calls: result.budget.calls, tokens: result.budget.tokens },
        error: result.error ?? advisor.lastError ?? null,
        advisor: advisor.model,
      },
      null,
      2,
    ),
  );
}
