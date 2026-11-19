// QuantumOS #132: provider-neutral integration, endpoint/key isolation,
// model response handling, and no command-execution authority.
import assert from "node:assert/strict";
import { createChatAdvisor, resolveChatEndpoint } from "./ai-provider.mjs";
import { makeAdvisor } from "./facilitator-advisor.mjs";

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };

check(resolveChatEndpoint("openai") === "https://api.openai.com/v1/chat/completions",
  "OpenAI standard endpoint");
check(resolveChatEndpoint("ollama") === "http://127.0.0.1:11434/v1/chat/completions",
  "local Ollama-compatible endpoint");
check(resolveChatEndpoint("https://example.org/models/v1") ===
  "https://example.org/models/v1/chat/completions", "custom HTTPS endpoint");
check(resolveChatEndpoint("http://localhost:1234/v1") ===
  "http://localhost:1234/v1/chat/completions", "loopback model server");
for (const url of [
  "http://example.org/v1", "ftp://example.org/v1",
  "http://user:pass@localhost:1234/v1", "file:///etc/passwd",
  "https://example.org/v1?secret=x",
]) {
  assert.throws(() => resolveChatEndpoint(url));
  assertions++;
}

let captured;
const env = {OPENAI_API_KEY: "real-secret-never-to-custom", QOS_AI_API_KEY: "custom-token"};
const custom = createChatAdvisor({
  backend: "https://example.org/v1", model: "test-model", env,
  fetchImpl: async (url, opts) => {
    captured = {url, opts};
    return {ok: true, json: async () => ({choices: [{message: {content: " Proposed answer "}}]})};
  },
});
check(custom.enabled, "custom endpoint accepts explicit model");
const answer = await custom.ask("policy", [{role: "user", content: "question"}], 500);
check(answer.text === "Proposed answer", "completion text");
check(captured.opts.headers.authorization === "Bearer custom-token",
  "custom endpoint uses only its explicitly configured credential");
check(!JSON.stringify(captured).includes("real-secret-never-to-custom"),
  "OpenAI key never leaked to custom server");
check(JSON.parse(captured.opts.body).messages[0].role === "system",
  "system prompt preserved");
check(JSON.parse(captured.opts.body).stream === false, "non-streaming bounded requests");

let ollamaHeaders;
const local = createChatAdvisor({
  backend: "ollama", model: "qwen-local", env,
  fetchImpl: async (_url, opts) => {
    ollamaHeaders = opts.headers;
    return {ok: true, json: async () => ({choices: [{message: {content: "NONE"}}]})};
  },
});
check((await local.ask("rule", [{role: "user", content: "Q"}])).text === "NONE",
  "Ollama response follows compatible schema");
check(!("authorization" in ollamaHeaders), "Ollama does not receive remote API keys");

const noKey = createChatAdvisor({backend: "openai", env: {}, model: "test"});
check(!noKey.enabled, "OpenAI requires an explicit key");
check((await noKey.ask("s", [])).text === null, "disabled provider does not request");

const badResponse = createChatAdvisor({
  backend: "openai", env, model: "test",
  fetchImpl: async () => ({ok: false, status: 403, text: async () => "private echo"}),
});
const bad = await badResponse.ask("rule", [{role: "user", content: "Q"}]);
check(bad.error === "advisor HTTP 403", "no remote error-body echoes");
check(!JSON.stringify(bad).includes("private echo"), "no secret echo");

const failingResponse = createChatAdvisor({
  backend: "ollama", env, model: "test",
  fetchImpl: async () => {throw new Error("offline");},
});
check(/offline/.test((await failingResponse.ask("rule", [{role: "user", content: "Q"}])).error),
  "transport failure reported");

const oldFetch = globalThis.fetch;
globalThis.fetch = async (_url, opts) => {
  captured = opts;
  return {ok: true, json: async () => ({choices: [{message: {content: "/lemma Proposed by model"}}]})};
};
try {
  const adviser = makeAdvisor({
    ai: true, backend: "openai", model: "test", apiKey: "fake",
  });
  check(adviser.enabled, "makeAdvisor openai enabled with key");
  check((await adviser.advise("ask", {question: "test?", transcript: []})) ===
    "/lemma Proposed by model", "agent returns only suggested text");
  check(adviser.lastError === null, "successful provider clears error");
  check(captured.headers.authorization === "Bearer fake", "correct key passed");

  const noAdapter = makeAdvisor({ai:true, backend:"mcp"});
  check(!noAdapter.enabled, "MCP needs explicit client binding");
  const injected = makeAdvisor({
    ai:true,backend:"mcp",
    mcpAdvisor: {ask: async (system, messages) =>
      ({text: "MCP draft: " + (messages[0]?.content || "")})},
  });
  check(injected.enabled, "MCP can be supplied by an explicit external client");
  check((await injected.advise("ask", {question:"test?", transcript:[]})).startsWith("MCP draft:"),
    "MCP adapter receives prompt but no command executor");
  check(!makeAdvisor({ai:true,backend:"unknown",apiKey:"fake"}).enabled,
    "unknown backend cannot silently fall back to Anthropic");

  globalThis.fetch = async (url, opts) => {
    captured = {url, opts};
    return {ok:true, json:async () => ({content:[{text:"Legacy Anthropic reply"}]})};
  };
  const legacy = makeAdvisor({ai:true,backend:"api",apiKey:"legacy-key",model:"test"});
  check((await legacy.advise("ask", {question:"old API?", transcript:[]})) ===
    "Legacy Anthropic reply", "original Anthropic API remains supported");
  check(captured.url === "https://api.anthropic.com/v1/messages",
    "legacy provider endpoint is unchanged");
  check(captured.opts.headers["x-api-key"] === "legacy-key",
    "original Anthropic credential header unchanged");
} finally {globalThis.fetch = oldFetch;}

console.log("PASS: advisor-provider.selftest.mjs — " + assertions + " assertions");
