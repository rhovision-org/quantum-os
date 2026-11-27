// Shared helper for any OpenAI-compatible /chat/completions endpoint
// (DeepSeek, and most other hosted or local model servers). A plugin for one of
// them is a few lines: see deepseek.mjs.

export function openAICompatible({ name, describe, baseUrl, keyEnv, defaultModel }) {
  return {
    name, describe, keyEnv, defaultModel,
    unavailable(env) { return !keyEnv || env[keyEnv] ? null : `${keyEnv} is not set`; },
    async complete({ system, prompt, maxTokens, model, timeoutMs = 45_000, env, fetchImpl = fetch }) {
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(keyEnv ? { authorization: `Bearer ${env[keyEnv]}` } : {}),
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          let body = "";
          try { body = (await res.text()).slice(0, 300); } catch { /* optional */ }
          return { error: `${name} HTTP ${res.status}${body ? `: ${body}` : ""}` };
        }
        const j = await res.json();
        return { text: String(j?.choices?.[0]?.message?.content ?? "").trim() };
      } catch (e) {
        return { error: `${name} error: ${e?.message ?? e}` };
      }
    },
  };
}
