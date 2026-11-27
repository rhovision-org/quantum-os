// DeepSeek — OpenAI-compatible API, key from DEEPSEEK_API_KEY.
// DEEPSEEK_BASE_URL points it at another host serving the same API.
import { openAICompatible } from "./openai-compatible.mjs";

export default openAICompatible({
  name: "deepseek",
  describe: "DeepSeek over its API (DEEPSEEK_API_KEY, pay as you go)",
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  keyEnv: "DEEPSEEK_API_KEY",
  defaultModel: "deepseek-chat",
});
