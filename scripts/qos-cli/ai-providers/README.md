# AI provider plugins

An agent's AI advisor talks to its model through a **provider plugin**: one ES
module per provider, all with the same small shape. The built-in ones live in
this directory; your own can live anywhere and is loaded by path.

```bash
node agent.mjs --room <cap> --ai --ai-backend deepseek          # a built-in, by name
node agent.mjs --room <cap> --ai --ai-backend ./my-provider.mjs # your own, by path
```

| Name | Module | Key (on the agent's machine) | Default model |
|------|--------|------------------------------|---------------|
| `anthropic` (alias `api`) | [anthropic.mjs](anthropic.mjs) | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` |
| `claude-code` (alias `claude`, `cli`) | [claude-code.mjs](claude-code.mjs) | none — the logged-in `claude` CLI, your Claude plan | the CLI's own |
| `deepseek` | [deepseek.mjs](deepseek.mjs) | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `openai` | [openai.mjs](openai.mjs) | `OPENAI_API_KEY` | `gpt-4.1-mini` |
| `ollama` (alias `localhost`) | [ollama.mjs](ollama.mjs) | none | `llama3.2` |
| `custom` | [custom.mjs](custom.mjs) | optional `QOS_AI_API_KEY` | choose with `--ai-model` or `QOS_AI_MODEL` |

`openai` uses the official OpenAI endpoint. `ollama` defaults to
`http://127.0.0.1:11434/v1` and accepts `OLLAMA_BASE_URL`. Set
`QOS_AI_BASE_URL` for `custom`, for example `https://models.example/v1`.
Configured URLs use HTTPS or loopback HTTP. Set the model with `--ai-model`
or `QOS_AI_MODEL`. The detached launcher accepts `AI_BACKEND`.

**Keys never go through the room.** A provider reads its key from the
environment of the machine running the agent. The browser's `/agent add … --ai
deepseek` only names the provider; nothing secret is in the line it copies.

## Writing one

```js
// my-provider.mjs
export default {
  name: "my-provider",
  describe: "what it is, one line",
  keyEnv: "MY_PROVIDER_API_KEY",   // null if it needs no key
  defaultModel: "some-model",
  // null when usable, otherwise why not (shown in the agent's log).
  unavailable(env) { return env.MY_PROVIDER_API_KEY ? null : "MY_PROVIDER_API_KEY is not set"; },
  // One completion. Never throw: return { text } or { error }.
  async complete({ system, prompt, maxTokens, model, timeoutMs, env, log }) {
    return { text: "…" };
  },
};
```

An OpenAI-compatible service needs only a few lines: see how
[deepseek.mjs](deepseek.mjs) wraps [openai-compatible.mjs](openai-compatible.mjs).
`node ai-providers.selftest.mjs` (one directory up) checks every built-in against
this contract.
