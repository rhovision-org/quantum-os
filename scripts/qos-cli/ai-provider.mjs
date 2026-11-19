// Provider-neutral, advisory-only chat completion adapter for QuantumOS #132.
// Every provider returns text; no room capability, signing key, command runner,
// filesystem or deployment handle is ever exposed to the remote model.
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function resolveChatEndpoint(backend, env = process.env) {
  const selected = String(backend ?? "").trim();
  let base;
  if (selected === "openai") base = env.OPENAI_BASE_URL || OPENAI_URL;
  else if (selected === "ollama") base = env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1";
  else base = selected;
  let url;
  try { url = new URL(base); }
  catch { throw new Error("advisor provider requires a valid backend URL"); }
  if (!["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash)
    throw new Error("invalid advisor backend URL");
  if (url.protocol === "http:" && !LOCAL.has(url.hostname.toLowerCase()))
    throw new Error("insecure non-loopback advisor URL refused (use HTTPS)");
  const p = url.pathname.replace(/\/+$/, "");
  if (p.endsWith("/chat/completions")) url.pathname = p;
  else if (p.endsWith("/v1")) url.pathname = p + "/chat/completions";
  else url.pathname = p + "/v1/chat/completions";
  return url.toString();
}

export function createChatAdvisor({
  backend, apiKey, model, timeoutMs = 45_000,
  fetchImpl = globalThis.fetch, env = process.env, log = () => {},
} = {}) {
  const endpoint = resolveChatEndpoint(backend, env);
  const isOpenAI = backend === "openai";
  const isOllama = backend === "ollama";
  // Do not accidentally send OPENAI_API_KEY to an arbitrary custom endpoint.
  // Custom servers require an explicitly provided key or QOS_AI_API_KEY.
  const key = apiKey !== undefined ? apiKey :
    isOpenAI ? env.OPENAI_API_KEY :
    isOllama ? undefined : env.QOS_AI_API_KEY;
  const chosenModel = model || env.QOS_AI_MODEL ||
    (isOpenAI ? "gpt-4.1-mini" : isOllama ? "llama3.2" : "");
  const enabled = Boolean(chosenModel && (isOpenAI ? key : true));
  if (!enabled) log("[advisor] provider disabled: missing API key or model name");
  const label = enabled ? backend + " " + chosenModel : "off";
  return {
    enabled, label, endpoint,
    async ask(system, messages, maxTokens = 256) {
      if (!enabled) return { text: null, error: "advisor provider disabled" };
      if (!Array.isArray(messages) || !messages.every(m =>
        m && ["user", "assistant"].includes(m.role) && typeof m.content === "string"))
        return { text: null, error: "invalid advisor messages" };
      if (typeof fetchImpl !== "function")
        return { text: null, error: "fetch unavailable on this Node runtime" };
      const safeMax = Math.max(1, Math.min(2048, Math.floor(maxTokens) || 256));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = { "content-type": "application/json" };
        if (key) headers.authorization = "Bearer " + key;
        const res = await fetchImpl(endpoint, {
          method: "POST", headers, signal: controller.signal,
          body: JSON.stringify({
            model: chosenModel,
            messages: [{ role: "system", content: String(system).slice(0, 14000) },
              ...messages.map(m => ({ role: m.role, content: m.content.slice(0, 16000) }))],
            max_tokens: safeMax, stream: false,
          }),
        });
        if (!res.ok) {
          // Never echo remote response bodies: proxies may reflect credentials
          // or private prompt material. Preserve only protocol status.
          return { text: null, error: "advisor HTTP " + res.status };
        }
        const json = await res.json();
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim())
          return { text: null, error: "advisor returned no completion text" };
        return { text: text.trim(), error: null };
      } catch (error) {
        const msg = error?.name === "AbortError" ? "advisor timed out" :
          "advisor transport error: " + (error?.message ?? "unknown");
        log("[advisor] " + msg);
        return { text: null, error: msg };
      } finally { clearTimeout(timer); }
    },
  };
}
