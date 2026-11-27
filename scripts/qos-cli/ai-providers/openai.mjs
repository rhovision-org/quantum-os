import { openAICompatible } from "./openai-compatible.mjs";

export default openAICompatible({
  name: "openai",
  describe: "OpenAI API (OPENAI_API_KEY)",
  baseUrl: () => "https://api.openai.com/v1",
  keyEnv: "OPENAI_API_KEY",
  defaultModel: "gpt-4.1-mini",
});
