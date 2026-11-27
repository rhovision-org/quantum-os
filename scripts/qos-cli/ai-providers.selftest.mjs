// ai-providers.selftest.mjs — every AI provider plugin keeps the contract, and
// the advisor reaches DeepSeek and Anthropic correctly without a network:
// a stub fetch records the request and answers like the real API.
//
//   node scripts/qos-cli/ai-providers.selftest.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN, loadProvider, providerShapeError, builtinName } from "./ai-providers/index.mjs";
import { makeAdvisor } from "./facilitator-advisor.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

for (const [n, p] of Object.entries(BUILTIN)) {
  ok(`${n}: has the plugin shape`, providerShapeError(p) === null, providerShapeError(p));
  ok(`${n}: registered under its own name`, p.name === n);
  ok(`${n}: describes itself`, typeof p.describe === "string" && p.describe.length > 0);
}
ok("aliases: api → anthropic", builtinName("api") === "anthropic");
ok("aliases: claude → claude-code", builtinName("claude") === "claude-code");
ok("aliases: empty → anthropic", builtinName("") === "anthropic");
ok("DeepSeek needs its key", BUILTIN.deepseek.unavailable({}) === "DEEPSEEK_API_KEY is not set");
ok("DeepSeek with a key is usable", BUILTIN.deepseek.unavailable({ DEEPSEEK_API_KEY: "k" }) === null);

// A stub that records what was sent and replies in the API's own shape.
function stub(reply, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => reply, text: async () => JSON.stringify(reply) };
  };
  return { calls, fetchImpl };
}

{
  const s = stub({ choices: [{ message: { content: " Use /poll. " } }] });
  const adv = makeAdvisor({ ai: true, backend: "deepseek", env: { DEEPSEEK_API_KEY: "sk-test" }, fetchImpl: s.fetchImpl });
  ok("deepseek advisor is enabled with a key", adv.enabled, adv.model);
  ok("deepseek label names provider and model", adv.model === "deepseek deepseek-chat", adv.model);
  const text = await adv.advise("ask", { question: "how do we vote?", transcript: [] });
  ok("deepseek answer comes back trimmed", text === "Use /poll.", String(text));
  const c = s.calls[0];
  ok("deepseek: posts to /chat/completions", c?.url === "https://api.deepseek.com/chat/completions", c?.url);
  ok("deepseek: bearer key from the environment", c?.headers?.authorization === "Bearer sk-test");
  ok("deepseek: system then user message", c?.body?.messages?.[0]?.role === "system" && c?.body?.messages?.[1]?.role === "user");
  ok("deepseek: default model", c?.body?.model === "deepseek-chat");
}
{
  const adv = makeAdvisor({ ai: true, backend: "deepseek", env: {}, log: () => {} });
  ok("deepseek without a key stays off", adv.enabled === false);
}
{
  const s = stub({ error: { message: "Insufficient Balance" } }, 402);
  const adv = makeAdvisor({ ai: true, backend: "deepseek", env: { DEEPSEEK_API_KEY: "k" }, fetchImpl: s.fetchImpl, log: () => {} });
  const text = await adv.advise("ask", { question: "q", transcript: [] });
  ok("an HTTP failure returns no answer", text === null);
  ok("…and says why", /deepseek HTTP 402.*Insufficient Balance/.test(adv.lastError ?? ""), adv.lastError);
}
{
  const s = stub({ content: [{ text: "Try /estimate." }] });
  const adv = makeAdvisor({ ai: true, backend: "api", apiKey: "a-key", fetchImpl: s.fetchImpl, model: "claude-x" });
  const text = await adv.advise("ask", { question: "q", transcript: [] });
  ok("anthropic still answers through its plugin", text === "Try /estimate.", String(text));
  ok("anthropic: key header and chosen model", s.calls[0]?.headers?.["x-api-key"] === "a-key" && s.calls[0]?.body?.model === "claude-x");
}

{
  const s = stub({ choices: [{ message: { content: " Use /poll. " } }] });
  const env = { OPENAI_API_KEY: "openai-test", OPENAI_BASE_URL: "https://other.example/v1",
    QOS_AI_BASE_URL: "https://custom.example/v1/", QOS_AI_MODEL: "configured-model" };
  const ask = (backend, options = {}) => makeAdvisor({ ai: true, backend, env, fetchImpl: s.fetchImpl, ...options })
    .advise("ask", { question: "q", transcript: [] });
  ok("OpenAI through the advisor", await ask("openai") === "Use /poll.");
  ok("OpenAI key reaches only the official endpoint", s.calls[0]?.url === "https://api.openai.com/v1/chat/completions" &&
    s.calls[0]?.headers?.authorization === "Bearer openai-test" && s.calls[0]?.redirect === "error");
  ok("Ollama through the localhost alias", await ask("localhost", { model: "local-model" }) === "Use /poll.");
  ok("Ollama uses loopback without a key", s.calls[1]?.url === "http://127.0.0.1:11434/v1/chat/completions" &&
    !s.calls[1]?.headers?.authorization && s.calls[1]?.body?.model === "local-model");
  ok("custom can run anonymously", await ask("custom") === "Use /poll." && !s.calls[2]?.headers?.authorization);
  const configured = { ...env, QOS_AI_API_KEY: "custom-test" };
  ok("custom uses its own URL, key and model", await ask("custom", { env: configured }) === "Use /poll." &&
    s.calls[3]?.url === "https://custom.example/v1/chat/completions" &&
    s.calls[3]?.headers?.authorization === "Bearer custom-test" && s.calls[3]?.body?.model === "configured-model");
  for (const base of ["http://models.example/v1", "https://user:pass@models.example/v1",
    "https://models.example/v1?key=value", "https://models.example/v1#fragment"]) {
    ok(`custom rejects ${new URL(base).origin} with insecure URL configuration`,
      !(await ask("custom", { env: { ...configured, QOS_AI_BASE_URL: base } })));
  }
  ok("no request uses a refused URL or an absent model", !(await ask("custom", {
    env: { QOS_AI_BASE_URL: env.QOS_AI_BASE_URL },
  })) && s.calls.length === 4);
}
{
  const s = stub({ error: "reflected private material" }, 403);
  const adv = makeAdvisor({ ai: true, backend: "ollama", env: {}, fetchImpl: s.fetchImpl });
  const text = await adv.advise("ask", { question: "q", transcript: [] });
  ok("configured provider does not report remote error bodies", text === null && adv.lastError === "ollama HTTP 403");
}

// A plugin of your own, by path.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qos-provider-"));
try {
  const plug = path.join(dir, "echo-provider.mjs");
  fs.writeFileSync(plug, `export default { name: "echo", describe: "test", keyEnv: null, defaultModel: "e1",
    unavailable() { return null; },
    async complete({ prompt, model }) { return { text: model + ":" + prompt.length }; } };`);
  const p = await loadProvider(plug);
  ok("a plugin loads by path", p.name === "echo");
  const adv = makeAdvisor({ ai: true, provider: p });
  const text = await adv.advise("ask", { question: "hi", transcript: [] });
  ok("the advisor uses a plugin passed in", /^e1:\d+$/.test(String(text)), String(text));
  const bad = path.join(dir, "bad.mjs");
  fs.writeFileSync(bad, `export default { name: "bad" };`);
  let err = "";
  try { await loadProvider(bad); } catch (e) { err = e.message; }
  ok("a plugin without complete() is refused, saying so", /complete\(\)/.test(err), err);
  err = "";
  try { await loadProvider("nosuch"); } catch (e) { err = e.message; }
  ok("an unknown name lists the built-ins", /deepseek/.test(err) && /claude-code/.test(err), err);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ai-providers.selftest.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
