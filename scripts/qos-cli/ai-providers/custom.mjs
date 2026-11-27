import { openAICompatible } from "./openai-compatible.mjs";

export default openAICompatible({
  name: "custom",
  describe: "An OpenAI-compatible endpoint configured by QOS_AI_BASE_URL",
  baseUrl: (env) => env.QOS_AI_BASE_URL,
  keyEnv: "QOS_AI_API_KEY",
  optionalKey: true,
  defaultModel: null,
});
