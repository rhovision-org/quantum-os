// Anthropic Messages API — pay-as-you-go credits, key from ANTHROPIC_API_KEY.
const URL = "https://api.anthropic.com/v1/messages";

export default {
  name: "anthropic",
  describe: "Claude over the Anthropic API (ANTHROPIC_API_KEY, pay as you go)",
  keyEnv: "ANTHROPIC_API_KEY",
  defaultModel: "claude-haiku-4-5-20251001",
  unavailable(env) { return env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY is not set"; },
  async complete({ system, prompt, maxTokens, model, timeoutMs = 45_000, env, fetchImpl = fetch }) {
    try {
      const res = await fetchImpl(URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        let body = "";
        try { body = (await res.text()).slice(0, 300); } catch { /* optional */ }
        return { error: `anthropic HTTP ${res.status}${body ? `: ${body}` : ""}` };
      }
      const j = await res.json();
      return { text: (j?.content?.[0]?.text ?? "").trim() };
    } catch (e) {
      return { error: `anthropic error: ${e?.message ?? e}` };
    }
  },
};
