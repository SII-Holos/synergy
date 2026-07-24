import type { Provider as SDK } from "ai"

type Factory = (options: Record<string, unknown>) => SDK

export async function loadBundledProvider(packageName: string): Promise<Factory | undefined> {
  switch (packageName) {
    case "@ai-sdk/amazon-bedrock":
      return (await import("@ai-sdk/amazon-bedrock")).createAmazonBedrock as Factory
    case "@ai-sdk/anthropic":
      return (await import("@ai-sdk/anthropic")).createAnthropic as Factory
    case "@ai-sdk/azure":
      return (await import("@ai-sdk/azure")).createAzure as Factory
    case "@ai-sdk/google":
      return (await import("@ai-sdk/google")).createGoogleGenerativeAI as Factory
    case "@ai-sdk/google-vertex":
      return (await import("@ai-sdk/google-vertex")).createVertex as Factory
    case "@ai-sdk/google-vertex/anthropic":
      return (await import("@ai-sdk/google-vertex/anthropic")).createVertexAnthropic as Factory
    case "@ai-sdk/openai":
      return (await import("@ai-sdk/openai")).createOpenAI as Factory
    case "@ai-sdk/openai-compatible":
      return (await import("@ai-sdk/openai-compatible")).createOpenAICompatible as unknown as Factory
    case "@openrouter/ai-sdk-provider":
      return (await import("@openrouter/ai-sdk-provider")).createOpenRouter as Factory
    case "@ai-sdk/xai":
      return (await import("@ai-sdk/xai")).createXai as Factory
    case "@ai-sdk/mistral":
      return (await import("@ai-sdk/mistral")).createMistral as Factory
    case "@ai-sdk/groq":
      return (await import("@ai-sdk/groq")).createGroq as Factory
    case "@ai-sdk/deepinfra":
      return (await import("@ai-sdk/deepinfra")).createDeepInfra as Factory
    case "@ai-sdk/cerebras":
      return (await import("@ai-sdk/cerebras")).createCerebras as Factory
    case "@ai-sdk/cohere":
      return (await import("@ai-sdk/cohere")).createCohere as Factory
    case "@ai-sdk/gateway":
      return (await import("@ai-sdk/gateway")).createGateway as Factory
    case "@ai-sdk/togetherai":
      return (await import("@ai-sdk/togetherai")).createTogetherAI as Factory
    case "@ai-sdk/perplexity":
      return (await import("@ai-sdk/perplexity")).createPerplexity as Factory
    case "@ai-sdk/vercel":
      return (await import("@ai-sdk/vercel")).createVercel as Factory
  }
}

export function loadBundledProviderSync(packageName: string): Factory | undefined {
  switch (packageName) {
    case "@ai-sdk/amazon-bedrock":
      return require("@ai-sdk/amazon-bedrock").createAmazonBedrock as Factory
    case "@ai-sdk/anthropic":
      return require("@ai-sdk/anthropic").createAnthropic as Factory
    case "@ai-sdk/azure":
      return require("@ai-sdk/azure").createAzure as Factory
    case "@ai-sdk/google":
      return require("@ai-sdk/google").createGoogleGenerativeAI as Factory
    case "@ai-sdk/google-vertex":
      return require("@ai-sdk/google-vertex").createVertex as Factory
    case "@ai-sdk/google-vertex/anthropic":
      return require("@ai-sdk/google-vertex/anthropic").createVertexAnthropic as Factory
    case "@ai-sdk/openai":
      return require("@ai-sdk/openai").createOpenAI as Factory
    case "@ai-sdk/openai-compatible":
      return require("@ai-sdk/openai-compatible").createOpenAICompatible as Factory
    case "@openrouter/ai-sdk-provider":
      return require("@openrouter/ai-sdk-provider").createOpenRouter as Factory
    case "@ai-sdk/xai":
      return require("@ai-sdk/xai").createXai as Factory
    case "@ai-sdk/mistral":
      return require("@ai-sdk/mistral").createMistral as Factory
    case "@ai-sdk/groq":
      return require("@ai-sdk/groq").createGroq as Factory
    case "@ai-sdk/deepinfra":
      return require("@ai-sdk/deepinfra").createDeepInfra as Factory
    case "@ai-sdk/cerebras":
      return require("@ai-sdk/cerebras").createCerebras as Factory
    case "@ai-sdk/cohere":
      return require("@ai-sdk/cohere").createCohere as Factory
    case "@ai-sdk/gateway":
      return require("@ai-sdk/gateway").createGateway as Factory
    case "@ai-sdk/togetherai":
      return require("@ai-sdk/togetherai").createTogetherAI as Factory
    case "@ai-sdk/perplexity":
      return require("@ai-sdk/perplexity").createPerplexity as Factory
    case "@ai-sdk/vercel":
      return require("@ai-sdk/vercel").createVercel as Factory
  }
}
