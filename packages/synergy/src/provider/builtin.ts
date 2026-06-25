import { ProviderProfile } from "./profile"
import { CodexProvider } from "./codex"
import { AnthropicOAuthProvider } from "./anthropic-oauth"
import { CopilotProvider } from "./copilot"
import { MiniMaxProvider } from "./minimax"
import { AccountUsage } from "./usage"

let registered = false

export function registerBuiltinProviderProfiles() {
  if (registered) return
  registered = true

  ProviderProfile.register({
    id: CodexProvider.PROVIDER_ID,
    name: "OpenAI Codex",
    description: "OpenAI Codex via ChatGPT/Codex subscription login",
    baseURL: CodexProvider.BASE_URL,
    apiMode: "codex_responses",
    authKind: "oauth_external",
    aiSdkPackage: "@ai-sdk/openai",
    modelFactory: "openaiResponses",
    modelsDevProviderID: "openai",
    fallbackModels: [...CodexProvider.DEFAULT_MODEL_IDS],
    liveModelDiscovery: "codex",
    usageKind: "codex",
    runtimeOptions: async () => {
      const access = await CodexProvider.resolveToken({ allowMissing: true }).catch(() => undefined)
      if (!access) return {}
      return {
        apiKey: "synergy-codex-oauth",
        baseURL: CodexProvider.runtimeBaseURL(),
        fetch: CodexProvider.codexFetch,
        setCacheKey: true,
      }
    },
    fetchModels: async (input) => {
      const access = await CodexProvider.resolveToken({ allowMissing: true, fetch: input.fetch }).catch(() => undefined)
      if (!access) return []
      return CodexProvider.fetchModelIDs(access, input.fetch)
    },
    fetchUsage: (input) => CodexProvider.fetchUsage(input?.fetch),
  })

  ProviderProfile.register({
    id: "anthropic",
    name: "Anthropic",
    description: "Anthropic API key or Claude subscription OAuth",
    baseURL: "https://api.anthropic.com/v1",
    apiMode: "anthropic_messages",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/anthropic",
    modelFactory: "languageModel",
    modelsDevProviderID: "anthropic",
    usageKind: "anthropic-oauth",
    runtimeOptions: async (input) => {
      if (input.auth?.type !== "oauth") {
        return {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        }
      }
      return {
        apiKey: "synergy-anthropic-oauth",
        fetch: AnthropicOAuthProvider.anthropicFetch,
        headers: {
          "anthropic-beta":
            "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        },
      }
    },
    fetchUsage: (input) => AnthropicOAuthProvider.fetchUsage(input?.fetch),
  })

  ProviderProfile.register({
    id: "github-copilot",
    name: "GitHub Copilot",
    aliases: ["copilot", "github-models"],
    baseURL: CopilotProvider.BASE_URL,
    apiMode: "chat_completions",
    authKind: "copilot",
    aiSdkPackage: "@ai-sdk/github-copilot",
    modelFactory: "copilotAuto",
    modelsDevProviderID: "github-copilot",
    fallbackModels: [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "claude-sonnet-4.6",
      "claude-haiku-4.5",
      "gemini-3-pro-preview",
    ],
    liveModelDiscovery: "copilot",
    runtimeOptions: async () => ({
      baseURL: CopilotProvider.BASE_URL,
      fetch: CopilotProvider.copilotFetchFor("github-copilot"),
    }),
    fetchModels: (input) => CopilotProvider.fetchModelIDs("github-copilot", input.fetch),
  })

  ProviderProfile.register({
    id: "github-copilot-enterprise",
    name: "GitHub Copilot Enterprise",
    baseURL: CopilotProvider.BASE_URL,
    apiMode: "chat_completions",
    authKind: "copilot",
    aiSdkPackage: "@ai-sdk/github-copilot",
    modelFactory: "copilotAuto",
    modelsDevProviderID: "github-copilot",
    fallbackModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "claude-sonnet-4.6"],
    runtimeOptions: async () => ({
      baseURL: CopilotProvider.BASE_URL,
      fetch: CopilotProvider.copilotFetchFor("github-copilot-enterprise"),
    }),
    fetchModels: (input) => CopilotProvider.fetchModelIDs("github-copilot-enterprise", input.fetch),
  })

  ProviderProfile.register({
    id: MiniMaxProvider.PROVIDER_ID,
    name: "MiniMax (OAuth)",
    description: "MiniMax via OAuth browser flow",
    baseURL: MiniMaxProvider.GLOBAL_INFERENCE,
    apiMode: "anthropic_messages",
    authKind: "oauth_external",
    aiSdkPackage: "@ai-sdk/anthropic",
    modelFactory: "languageModel",
    modelsDevProviderID: "minimax",
    fallbackModels: ["MiniMax-M2.7", "MiniMax-M3"],
    runtimeOptions: async () => ({
      apiKey: "synergy-minimax-oauth",
      baseURL: MiniMaxProvider.GLOBAL_INFERENCE,
      fetch: MiniMaxProvider.minimaxFetch,
    }),
  })

  ProviderProfile.register({
    id: "alibaba-coding-plan",
    name: "Alibaba Cloud (Coding Plan)",
    baseURL: "https://coding-intl.dashscope.aliyuncs.com/v1",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    modelsDevProviderID: "alibaba-coding-plan",
    fallbackModels: ["qwen3-coder-plus", "qwen3-max"],
  })

  ProviderProfile.register({
    id: "qwen-oauth",
    name: "Qwen OAuth",
    baseURL: "https://portal.qwen.ai/v1",
    authKind: "oauth_external",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    modelsDevProviderID: "alibaba",
    fallbackModels: ["qwen3-coder-plus", "qwen3-max", "qwen3-plus"],
  })

  ProviderProfile.register({
    id: "xiaomi",
    name: "Xiaomi MiMo",
    aliases: ["mimo", "xiaomi-mimo"],
    baseURL: "https://api.xiaomimimo.com/v1",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    modelsDevProviderID: "xiaomi",
    fallbackModels: ["mimo-v2.5-pro", "mimo-v2-omni"],
    healthCheck: "none",
    requestQuirks: ["no-vision-tool-messages"],
  })

  ProviderProfile.register({
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    authKind: "api_key",
    aiSdkPackage: "@openrouter/ai-sdk-provider",
    modelsDevProviderID: "openrouter",
    usageKind: "openrouter",
    fetchUsage: () => AccountUsage.openrouter("openrouter"),
  })
}
