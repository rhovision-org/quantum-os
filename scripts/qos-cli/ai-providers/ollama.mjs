import { openAICompatible } from "./openai-compatible.mjs";

export default openAICompatible({
  name: "ollama",
  describe: "Ollama on the agent machine (or OLLAMA_BASE_URL)",
  baseUrl: (env) => env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
  keyEnv: null,
  defaultModel: "llama3.2",
});
