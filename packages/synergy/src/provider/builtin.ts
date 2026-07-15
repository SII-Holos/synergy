import { ProviderProfile } from "./profile"
import { CodexProvider } from "./codex"
import { AnthropicOAuthProvider } from "./anthropic-oauth"
import { CopilotProvider } from "./copilot"
import { MiniMaxProvider } from "./minimax"
import { AccountUsage } from "./usage"
import { Config } from "@/config/config"
import { Auth } from "./api-key"
import { Env } from "@/util/env"
import { BunProc } from "@/util/bun"
import { iife } from "@/util/iife"
import { SYNERGY_REFERER } from "@/holos/constants"
import type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { ProviderAuthRecovery } from "./auth-recovery"

let registered = false

function recommended(input: {
  rank: number
  headline: string
  reason: string
  defaultModel?: string
  cta?: ProviderProfile.Recommendation["cta"]
}): ProviderProfile.Recommendation {
  return {
    level: "recommended",
    rank: input.rank,
    headline: input.headline,
    reason: input.reason,
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
    ...(input.cta ? { cta: input.cta } : {}),
  }
}

export function registerBuiltinProviderProfiles() {
  if (registered) return
  registered = true

  ProviderProfile.register({
    id: "openai",
    name: "OpenAI",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/openai",
    modelFactory: "openaiResponses",
    modelsDevProviderID: "openai",
    recommendation: recommended({
      rank: 40,
      headline: "OpenAI Platform",
      reason: "Use OpenAI Platform API keys for GPT models and OpenAI billing.",
      defaultModel: "gpt-4o",
      cta: { kind: "external", label: "Create OpenAI API key", url: "https://platform.openai.com/api-keys" },
    }),
  })

  ProviderProfile.register({
    id: CodexProvider.PROVIDER_ID,
    name: "OpenAI Codex",
    description: "OpenAI Codex via ChatGPT/Codex subscription login",
    recommendation: recommended({
      rank: 20,
      headline: "ChatGPT/Codex subscription",
      reason: "Connect a ChatGPT/Codex subscription for Codex-backed coding models.",
      defaultModel: "gpt-5.4-mini",
    }),
    baseURL: CodexProvider.BASE_URL,
    apiMode: "codex_responses",
    authKind: "oauth_external",
    aiSdkPackage: "@ai-sdk/openai",
    modelFactory: "openaiResponses",
    modelsDevProviderID: CodexProvider.PROVIDER_ID,
    sourceModelProviderID: "openai",
    fallbackModels: [...CodexProvider.DEFAULT_MODEL_IDS],
    liveModelDiscovery: "codex",
    usageKind: "codex",
    runtimeOptions: async () => {
      const access = await CodexProvider.resolveToken({ allowMissing: true }).catch(() => undefined)
      if (!access) return {}
      return {
        apiKey: "synergy-codex-oauth",
        baseURL: CodexProvider.runtimeBaseURL(),
        fetch: ProviderAuthRecovery.handled(CodexProvider.codexFetch),
        setCacheKey: true,
      }
    },
    fetchModels: async (input) => {
      const access = await CodexProvider.resolveToken({ allowMissing: true, fetch: input.fetch }).catch(() => undefined)
      if (!access) return []
      return CodexProvider.fetchModelIDs(access, input.fetch)
    },
    fetchModelCatalog: async (input) => {
      const access = await CodexProvider.resolveToken({ allowMissing: true, fetch: input.fetch }).catch(() => undefined)
      if (!access) return []
      return CodexProvider.fetchModelCatalog(access, input.fetch)
    },
    fetchUsage: (input) => CodexProvider.fetchUsage(input?.fetch),
    refreshAuth: (input) => (input.auth ? CodexProvider.refreshAuth(input.auth) : Promise.resolve(undefined)),
    classifyError: CodexProvider.classifyError,
  })

  ProviderProfile.register({
    id: "anthropic",
    name: "Anthropic",
    description: "Anthropic API key or Claude subscription OAuth",
    recommendation: recommended({
      rank: 10,
      headline: "Claude Pro/Max or API key",
      reason: "Connect Claude subscription OAuth or an Anthropic Platform key.",
      defaultModel: "claude-sonnet-4-5",
      cta: { kind: "external", label: "Create Anthropic API key", url: "https://console.anthropic.com/settings/keys" },
    }),
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
        fetch: ProviderAuthRecovery.handled(AnthropicOAuthProvider.anthropicFetch),
        headers: {
          "anthropic-beta":
            "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        },
      }
    },
    fetchUsage: (input) => AnthropicOAuthProvider.fetchUsage(input?.fetch),
    refreshAuth: (input) => (input.auth ? AnthropicOAuthProvider.refreshAuth(input.auth) : Promise.resolve(undefined)),
    classifyError: AnthropicOAuthProvider.classifyError,
  })

  ProviderProfile.register({
    id: "google",
    name: "Google",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/google",
    modelFactory: "languageModel",
    modelsDevProviderID: "google",
    recommendation: recommended({
      rank: 50,
      headline: "Google Gemini API",
      reason: "Connect a Gemini API key for Google models.",
      defaultModel: "gemini-2.5-flash",
      cta: { kind: "external", label: "Create Gemini API key", url: "https://aistudio.google.com/apikey" },
    }),
  })

  ProviderProfile.register({
    id: "github-copilot",
    name: "GitHub Copilot",
    aliases: ["copilot", "github-models"],
    recommendation: recommended({
      rank: 30,
      headline: "GitHub Copilot subscription",
      reason: "Use an existing GitHub Copilot subscription for coding-focused models.",
      defaultModel: "gpt-5.4-mini",
    }),
    env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    baseURL: CopilotProvider.BASE_URL,
    apiMode: "chat_completions",
    authKind: "copilot",
    aiSdkPackage: "@ai-sdk/openai",
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
      apiKey: "synergy-copilot",
      baseURL: CopilotProvider.BASE_URL,
      fetch: ProviderAuthRecovery.handled(CopilotProvider.copilotFetchFor("github-copilot")),
    }),
    getModel: async ({ sdk, modelID }) => {
      if (modelID.toLowerCase().includes("claude")) {
        return createAnthropic({
          name: "github-copilot",
          apiKey: "synergy-copilot",
          baseURL: CopilotProvider.BASE_URL,
          fetch: ProviderAuthRecovery.handled(CopilotProvider.copilotFetchFor("github-copilot")) as typeof fetch,
        }).languageModel(modelID)
      }
      if (modelID.includes("codex") || modelID.startsWith("gpt-5")) return sdk.responses(modelID)
      return sdk.chat(modelID)
    },
    fetchModelCatalog: (input) => CopilotProvider.fetchModelCatalog("github-copilot", input.fetch),
    refreshAuth: (input) =>
      input.auth ? CopilotProvider.refreshAuth("github-copilot", input.auth) : Promise.resolve(undefined),
    classifyError: CopilotProvider.classifyError,
  })

  ProviderProfile.register({
    id: "github-copilot-enterprise",
    name: "GitHub Copilot Enterprise",
    env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    baseURL: CopilotProvider.BASE_URL,
    apiMode: "chat_completions",
    authKind: "copilot",
    aiSdkPackage: "@ai-sdk/openai",
    modelFactory: "copilotAuto",
    modelsDevProviderID: "github-copilot",
    fallbackModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "claude-sonnet-4.6"],
    runtimeOptions: async () => ({
      apiKey: "synergy-copilot-enterprise",
      baseURL: CopilotProvider.BASE_URL,
      fetch: ProviderAuthRecovery.handled(CopilotProvider.copilotFetchFor("github-copilot-enterprise")),
    }),
    getModel: async ({ sdk, modelID }) => {
      if (modelID.toLowerCase().includes("claude")) {
        return createAnthropic({
          name: "github-copilot-enterprise",
          apiKey: "synergy-copilot-enterprise",
          baseURL: CopilotProvider.BASE_URL,
          fetch: ProviderAuthRecovery.handled(
            CopilotProvider.copilotFetchFor("github-copilot-enterprise"),
          ) as typeof fetch,
        }).languageModel(modelID)
      }
      if (modelID.includes("codex") || modelID.startsWith("gpt-5")) return sdk.responses(modelID)
      return sdk.chat(modelID)
    },
    fetchModelCatalog: (input) => CopilotProvider.fetchModelCatalog("github-copilot-enterprise", input.fetch),
    refreshAuth: (input) =>
      input.auth ? CopilotProvider.refreshAuth("github-copilot-enterprise", input.auth) : Promise.resolve(undefined),
    classifyError: CopilotProvider.classifyError,
  })

  ProviderProfile.register({
    id: "azure",
    name: "Azure OpenAI",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/azure",
    modelFactory: "openaiResponsesUnlessCompletionUrls",
    modelsDevProviderID: "azure",
  })

  ProviderProfile.register({
    id: "azure-cognitive-services",
    name: "Azure Cognitive Services",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/azure",
    modelFactory: "openaiResponsesUnlessCompletionUrls",
    modelsDevProviderID: "azure-cognitive-services",
    runtimeOptions: async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
      }
    },
  })

  ProviderProfile.register({
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/amazon-bedrock",
    modelFactory: "languageModel",
    modelsDevProviderID: "amazon-bedrock",
    autoload: async () => {
      const config = await Config.current()
      const providerConfig = config.provider?.["amazon-bedrock"]
      const profile = providerConfig?.options?.profile ?? Env.get("AWS_PROFILE")
      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")
      const auth = await Auth.get("amazon-bedrock")
      const awsBearerToken = Env.get("AWS_BEARER_TOKEN_BEDROCK") ?? (auth?.type === "api" ? auth.key : undefined)
      return Boolean(profile || awsAccessKeyId || awsBearerToken)
    },
    runtimeOptions: async () => {
      const config = await Config.current()
      const providerConfig = config.provider?.["amazon-bedrock"]
      const auth = await Auth.get("amazon-bedrock")
      const defaultRegion = providerConfig?.options?.region ?? Env.get("AWS_REGION") ?? "us-east-1"
      const profile = providerConfig?.options?.profile ?? Env.get("AWS_PROFILE")
      const awsBearerToken = iife(() => {
        const envToken = Env.get("AWS_BEARER_TOKEN_BEDROCK")
        if (envToken) return envToken
        if (auth?.type === "api") {
          Env.set("AWS_BEARER_TOKEN_BEDROCK", auth.key)
          return auth.key
        }
        return undefined
      })
      if (!profile && !Env.get("AWS_ACCESS_KEY_ID") && !awsBearerToken) return {}

      const { fromNodeProviderChain } = await import((await BunProc.install("@aws-sdk/credential-providers")).entryPath)
      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
        credentialProvider: fromNodeProviderChain(profile ? { profile } : {}),
      }
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) providerOptions.baseURL = endpoint
      return providerOptions
    },
    getModel: async ({ sdk, modelID, options }) => {
      if (modelID.startsWith("global.") || modelID.startsWith("jp.")) return sdk.languageModel(modelID)
      const region = options?.region ?? Env.get("AWS_REGION") ?? "us-east-1"
      let regionPrefix = String(region).split("-")[0]

      switch (regionPrefix) {
        case "us": {
          const modelRequiresPrefix = [
            "nova-micro",
            "nova-lite",
            "nova-pro",
            "nova-premier",
            "claude",
            "deepseek",
          ].some((m) => modelID.includes(m))
          if (modelRequiresPrefix && !String(region).startsWith("us-gov")) modelID = `${regionPrefix}.${modelID}`
          break
        }
        case "eu": {
          const regionRequiresPrefix = [
            "eu-west-1",
            "eu-west-2",
            "eu-west-3",
            "eu-north-1",
            "eu-central-1",
            "eu-south-1",
            "eu-south-2",
          ].some((r) => String(region).includes(r))
          const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
            modelID.includes(m),
          )
          if (regionRequiresPrefix && modelRequiresPrefix) modelID = `${regionPrefix}.${modelID}`
          break
        }
        case "ap": {
          const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(String(region))
          const isTokyoRegion = region === "ap-northeast-1"
          const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) => modelID.includes(m))
          if (
            isAustraliaRegion &&
            ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
          ) {
            regionPrefix = "au"
            modelID = `${regionPrefix}.${modelID}`
          } else if (isTokyoRegion && modelRequiresPrefix) {
            regionPrefix = "jp"
            modelID = `${regionPrefix}.${modelID}`
          } else if (modelRequiresPrefix) {
            regionPrefix = "apac"
            modelID = `${regionPrefix}.${modelID}`
          }
          break
        }
      }

      return sdk.languageModel(modelID)
    },
  })

  ProviderProfile.register({
    id: "google-vertex",
    name: "Google Vertex",
    authKind: "wellknown",
    aiSdkPackage: "@ai-sdk/google-vertex",
    modelFactory: "languageModel",
    modelsDevProviderID: "google-vertex",
    autoload: async () =>
      Boolean(Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")),
    runtimeOptions: async () => ({
      project: Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT"),
      location: Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5",
    }),
  })

  ProviderProfile.register({
    id: "google-vertex-anthropic",
    name: "Google Vertex Anthropic",
    authKind: "wellknown",
    aiSdkPackage: "@ai-sdk/google-vertex/anthropic",
    modelFactory: "languageModel",
    modelsDevProviderID: "google-vertex-anthropic",
    autoload: async () =>
      Boolean(Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")),
    runtimeOptions: async () => ({
      project: Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT"),
      location: Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global",
    }),
  })

  ProviderProfile.register({
    id: "sap-ai-core",
    name: "SAP AI Core",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    modelFactory: "call",
    modelsDevProviderID: "sap-ai-core",
    autoload: async () => {
      const auth = await Auth.get("sap-ai-core")
      return Boolean(Env.get("AICORE_SERVICE_KEY") ?? (auth?.type === "api" ? auth.key : undefined))
    },
    runtimeOptions: async () => {
      const auth = await Auth.get("sap-ai-core")
      const envServiceKey = Env.get("AICORE_SERVICE_KEY") ?? (auth?.type === "api" ? auth.key : undefined)
      if (envServiceKey) Env.set("AICORE_SERVICE_KEY", envServiceKey)
      return envServiceKey
        ? {
            deploymentId: Env.get("AICORE_DEPLOYMENT_ID"),
            resourceGroup: Env.get("AICORE_RESOURCE_GROUP"),
          }
        : {}
    },
  })

  ProviderProfile.register({
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    modelFactory: "languageModel",
    modelsDevProviderID: "cloudflare-ai-gateway",
    autoload: async () => Boolean(Env.get("CLOUDFLARE_ACCOUNT_ID") && Env.get("CLOUDFLARE_GATEWAY_ID")),
    runtimeOptions: async ({ providerID }) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")
      if (!accountId || !gateway) return {}
      const auth = await Auth.get(providerID)
      const apiToken = Env.get("CLOUDFLARE_API_TOKEN") ?? (auth?.type === "api" ? auth.key : undefined)
      return {
        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
        headers: {
          ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : {}),
          "HTTP-Referer": "https://synergy.holosai.io/",
          "X-Title": "synergy",
        },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          headers.delete("Authorization")
          return fetch(input, { ...init, headers })
        },
      }
    },
  })

  ProviderProfile.register({
    id: "vercel",
    name: "Vercel AI Gateway",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/vercel",
    modelsDevProviderID: "vercel",
    recommendation: recommended({
      rank: 70,
      headline: "Vercel AI Gateway",
      reason: "Connect Vercel AI Gateway for model routing through Vercel.",
      defaultModel: "gpt-4o",
      cta: { kind: "external", label: "Create Vercel AI Gateway token", url: "https://vercel.link/ai-gateway-token" },
    }),
    runtimeOptions: async () => ({
      headers: {
        "http-referer": "https://synergy.holosai.io/",
        "x-title": "synergy",
      },
    }),
  })

  ProviderProfile.register({
    id: "zenmux",
    name: "ZenMux",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/openai-compatible",
    modelsDevProviderID: "zenmux",
    runtimeOptions: async () => ({
      headers: {
        "HTTP-Referer": "https://synergy.holosai.io/",
        "X-Title": "synergy",
      },
    }),
  })

  ProviderProfile.register({
    id: "cerebras",
    name: "Cerebras",
    authKind: "api_key",
    aiSdkPackage: "@ai-sdk/cerebras",
    modelsDevProviderID: "cerebras",
    runtimeOptions: async () => ({
      headers: {
        "X-Cerebras-3rd-Party-Integration": "synergy",
      },
    }),
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
      fetch: ProviderAuthRecovery.handled(MiniMaxProvider.minimaxFetch),
    }),
    refreshAuth: (input) => (input.auth ? MiniMaxProvider.refreshAuth(input.auth) : Promise.resolve(undefined)),
    classifyError: MiniMaxProvider.classifyError,
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
    description: "OpenRouter API key with optional credits and access to free model variants.",
    signupUrl: "https://openrouter.ai/keys",
    recommendation: recommended({
      rank: 60,
      headline: "OpenRouter models",
      reason:
        "An OpenRouter API key and user-managed credits or free-model access are required; Synergy does not provide hosted quota.",
      defaultModel: "openai/gpt-4o",
      cta: { kind: "external", label: "Create OpenRouter API key", url: "https://openrouter.ai/keys" },
    }),
    baseURL: "https://openrouter.ai/api/v1",
    authKind: "api_key",
    aiSdkPackage: "@openrouter/ai-sdk-provider",
    modelsDevProviderID: "openrouter",
    usageKind: "openrouter",
    runtimeOptions: async () => ({
      headers: {
        "HTTP-Referer": SYNERGY_REFERER,
        "X-OpenRouter-Title": "Synergy",
        "X-OpenRouter-Categories": "cli-agent,personal-agent",
      },
    }),
    fetchUsage: () => AccountUsage.openrouter("openrouter"),
  })
}
