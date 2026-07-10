import type { Provider as SDK } from "ai"
import type { ModelsDev } from "./models"
import type { Auth } from "./api-key"
import type { AccountUsage } from "./usage"
import z from "zod"

export namespace ProviderProfile {
  export type ApiMode = "chat_completions" | "responses" | "anthropic_messages" | "codex_responses" | "external_process"

  export type AuthKind = "api_key" | "oauth" | "oauth_external" | "copilot" | "wellknown" | "none"

  export type ModelFactory =
    | "languageModel"
    | "openaiResponses"
    | "openaiChat"
    | "openaiResponsesUnlessCompletionUrls"
    | "call"
    | "copilotAuto"
    | "anthropicMessages"

  export type HealthCheck = "models" | "none"

  export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export const Recommendation = z
    .object({
      level: z.enum(["featured", "recommended", "standard"]),
      rank: z.number().int().optional(),
      headline: z.string().optional(),
      reason: z.string().optional(),
      cta: z
        .object({
          kind: z.literal("external"),
          label: z.string(),
          url: z.string(),
        })
        .strict()
        .optional(),
      defaultModel: z.string().optional(),
    })
    .strict()
    .meta({ ref: "ProviderRecommendation" })
  export type Recommendation = z.infer<typeof Recommendation>

  export const Metadata = z
    .object({
      id: z.string(),
      name: z.string(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      signupUrl: z.string().optional(),
      authKind: z.string().optional(),
      environment: z.array(z.string()).optional(),
      recommendation: Recommendation.optional(),
    })
    .strict()
    .meta({ ref: "ProviderProfileMetadata" })
  export type Metadata = z.infer<typeof Metadata>

  export interface ClassifiedError {
    code: string
    retryable: boolean
    reloginRequired?: boolean
    exhausted?: boolean
    cooldownUntil?: number
    resetAt?: number
  }

  export interface RuntimeOptionsInput {
    auth?: Auth.Info
    provider?: ModelsDev.Provider
    providerID: string
  }

  export interface ModelFactoryInput {
    sdk: SDK | any
    modelID: string
    options?: Record<string, any>
  }

  export interface RequestInput {
    providerID: string
    auth?: Auth.Info
    url: string
    headers: Headers
    body?: unknown
  }

  export interface ModelCatalogEntry {
    id: string
    rank?: number
    model?: Partial<ModelsDev.Model>
  }

  export interface Profile {
    id: string
    name: string
    origin?: "builtin" | "plugin"
    aliases?: string[]
    displayName?: string
    description?: string
    signupUrl?: string
    recommendation?: Recommendation
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
    autoload?(input: RuntimeOptionsInput): Promise<boolean>
    resolveAuth?(input: RuntimeOptionsInput): Promise<Auth.Info | undefined>
    refreshAuth?(input: RuntimeOptionsInput): Promise<Auth.Info | undefined>
    buildHeaders?(input: RequestInput): Promise<Record<string, string> | Headers | undefined>
    rewriteBody?(input: RequestInput): Promise<unknown>
    modelOptions?(input: RuntimeOptionsInput): Promise<Record<string, any>>
    classifyError?(input: {
      providerID: string
      status?: number
      error?: unknown
      body?: unknown
    }): ClassifiedError | undefined
    runtimeOptions?(input: RuntimeOptionsInput): Promise<Record<string, any>>
    getModel?(input: ModelFactoryInput): Promise<any>
    fetchModelCatalog?(input: { auth?: Auth.Info; fetch?: FetchLike; baseURL?: string }): Promise<ModelCatalogEntry[]>
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

  export function clearPluginProfiles() {
    for (const [providerID, profile] of profiles) {
      if (profile.origin === "plugin") profiles.delete(providerID)
    }
    for (const [alias, providerID] of aliases) {
      if (!profiles.has(providerID)) aliases.delete(alias)
    }
  }

  export function canonicalID(providerID: string): string {
    return aliases.get(providerID) ?? providerID
  }

  export function metadata(profile: Profile): Metadata {
    return {
      id: profile.id,
      name: profile.name,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(profile.description ? { description: profile.description } : {}),
      ...(profile.signupUrl ? { signupUrl: profile.signupUrl } : {}),
      ...(profile.authKind ? { authKind: profile.authKind } : {}),
      ...(profile.env?.length ? { environment: profile.env } : {}),
      ...(profile.recommendation ? { recommendation: profile.recommendation } : {}),
    }
  }

  export function defaultModelFactory(factory: ModelFactory | undefined, input: ModelFactoryInput) {
    switch (factory) {
      case "openaiResponses":
        return input.sdk.responses(input.modelID)
      case "openaiChat":
        return input.sdk.chat(input.modelID)
      case "openaiResponsesUnlessCompletionUrls":
        if (input.options?.["useCompletionUrls"]) return input.sdk.chat(input.modelID)
        return input.sdk.responses(input.modelID)
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
