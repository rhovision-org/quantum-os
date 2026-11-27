// Shared helper for any OpenAI-compatible /chat/completions endpoint
// (DeepSeek, and most other hosted or local model servers). A plugin for one of
// them is a few lines: see deepseek.mjs.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function completionUrl(base) {
  let url;
  try { url = new URL(base); }
  catch { throw new Error("configure a valid OpenAI-compatible base URL"); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)))) {
    throw new Error("use an HTTPS or loopback HTTP URL without credentials, query or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    url.pathname = `${path}${path.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
  } else {
    url.pathname = path;
  }
  return url.href;
}

export function openAICompatible({ name, describe, baseUrl, keyEnv, defaultModel, optionalKey = false }) {
  // A resolver opts the provider into validated endpoints and redacted errors.
  // Static URLs retain the contract used by existing provider modules.
  const validated = typeof baseUrl === "function";
  const modelFor = (env, model) => model || env.QOS_AI_MODEL || defaultModel;
  function unavailable(env, model) {
    if (keyEnv && !optionalKey && !env[keyEnv]) return `${keyEnv} is not set`;
    if (!validated) return null;
    try { completionUrl(baseUrl(env)); }
    catch (error) { return error.message; }
    return modelFor(env, model) ? null : "set --ai-model or QOS_AI_MODEL";
  }

  return {
    name, describe, keyEnv, defaultModel, unavailable,
    async complete({ system, prompt, maxTokens, model, timeoutMs = 45_000, env, fetchImpl = fetch }) {
      const key = keyEnv && env[keyEnv];
      try {
        if (validated) {
          const error = unavailable(env, model);
          if (error) return { error };
        }
        const endpoint = validated ? completionUrl(baseUrl(env)) : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
        const headers = { "content-type": "application/json" };
        if (key || (!validated && keyEnv)) headers.authorization = "Bearer " + key;
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          ...(validated ? { redirect: "error" } : {}),
          body: JSON.stringify({
            model: validated ? modelFor(env, model) : model,
            max_tokens: maxTokens,
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          if (validated) return { error: `${name} HTTP ${res.status}` };
          let body = "";
          try { body = (await res.text()).slice(0, 300); } catch { /* optional */ }
          return { error: `${name} HTTP ${res.status}${body ? `: ${body}` : ""}` };
        }
        const j = await res.json();
        const content = j?.choices?.[0]?.message?.content;
        if (validated && (typeof content !== "string" || !content.trim())) {
          return { error: `${name} returned no completion text` };
        }
        return { text: String(content ?? "").trim() };
      } catch (error) {
        if (validated) {
          const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
          return { error: `${name} ${timedOut ? "timed out" : "transport error"}` };
        }
        return { error: `${name} error: ${error?.message ?? error}` };
      }
    },
  };
}
