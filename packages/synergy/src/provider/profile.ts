import type { Provider as SDK } from "ai"
import type { ModelsDev } from "./models"
import type { Auth } from "./api-key"
import type { AccountUsage } from "./usage"

export namespace ProviderProfile {
  export type ApiMode = "chat_completions" | "responses" | "anthropic_messages" | "codex_responses" | "external_process"

  export type AuthKind = "api_key" | "oauth" | "oauth_external" | "copilot" | "wellknown" | "none"

  export type ModelFactory =
    | "languageModel"
    | "openaiResponses"
    | "openaiChat"
    | "call"
    | "copilotAuto"
    | "anthropicMessages"

  export type HealthCheck = "models" | "none"

  export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export interface RuntimeOptionsInput {
    auth?: Auth.Info
    provider?: ModelsDev.Provider
  }

  export interface ModelFactoryInput {
    sdk: SDK | any
    modelID: string
    options?: Record<string, any>
  }

  export interface Profile {
    id: string
    name: string
    aliases?: string[]
    displayName?: string
    description?: string
    signupUrl?: string
    env?: string[]
    baseURL?: string
    modelsURL?: string
    apiMode?: ApiMode
    authKind?: AuthKind
    aiSdkPackage?: string
    modelFactory?: ModelFactory
    modelsDevProviderID?: string
    fallbackModels?: string[]
    defaultAuxModel?: string
    healthCheck?: HealthCheck
    supportsVision?: boolean
    supportsVisionToolMessages?: boolean
    liveModelDiscovery?: "none" | "openai-compatible" | "codex" | "copilot"
    usageKind?: AccountUsage.Kind
    requestQuirks?: string[]
    runtimeOptions?(input: RuntimeOptionsInput): Promise<Record<string, any>>
    getModel?(input: ModelFactoryInput): Promise<any>
    fetchModels?(input: { auth?: Auth.Info; fetch?: FetchLike; baseURL?: string }): Promise<string[]>
    fetchUsage?(input?: { fetch?: FetchLike }): Promise<AccountUsage.Snapshot>
  }

  const profiles = new Map<string, Profile>()
  const aliases = new Map<string, string>()

  export function register(profile: Profile) {
    profiles.set(profile.id, profile)
    for (const alias of profile.aliases ?? []) {
      aliases.set(alias, profile.id)
    }
  }

  export function get(providerID: string): Profile | undefined {
    return profiles.get(aliases.get(providerID) ?? providerID)
  }

  export function all(): Profile[] {
    return [...profiles.values()]
  }

  export function canonicalID(providerID: string): string {
    return aliases.get(providerID) ?? providerID
  }

  export function defaultModelFactory(factory: ModelFactory | undefined, input: ModelFactoryInput) {
    switch (factory) {
      case "openaiResponses":
        return input.sdk.responses(input.modelID)
      case "openaiChat":
        return input.sdk.chat(input.modelID)
      case "call":
        return input.sdk(input.modelID)
      case "copilotAuto":
        if (input.modelID.includes("codex") || input.modelID.startsWith("gpt-5"))
          return input.sdk.responses(input.modelID)
        return input.sdk.chat(input.modelID)
      case "anthropicMessages":
      case "languageModel":
      default:
        return input.sdk.languageModel(input.modelID)
    }
  }
}
