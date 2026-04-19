import { Auth } from "../provider/api-key"
import { ModelsDev } from "../provider/models"
import { Provider } from "../provider/provider"
import { ProviderTransform } from "../provider/transform"
import { Config } from "./config"
import { ConfigSet } from "./set"
import { RuntimeReload } from "../runtime/reload"
import { Global } from "../global"
import { BunProc } from "../util/bun"
import { Env } from "../util/env"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { embed, generateText, type ModelMessage } from "ai"
import { mergeDeep } from "remeda"
import z from "zod"
import path from "path"
import fs from "fs/promises"

export namespace ConfigSetup {
  export interface ProviderInfo {
    id: string
    name: string
    env: string[]
  }

  export interface ModelInfo {
    id: string
    name: string
    context: number
    reasoning: boolean
    multimodal: boolean
  }

  export type ConnectedProviderSourceKind = "stored-key" | "env" | "inline-key" | "draft-config"

  export interface ConnectedProviderSource {
    kind: ConnectedProviderSourceKind
    removable: boolean
    env?: string[]
  }

  export interface ConnectedProvider {
    id: string
    name: string
    source: "builtin" | "override" | "custom"
    sources: ConnectedProviderSource[]
    models: ModelInfo[]
    catalogModelCount: number
    accountModelCount?: number
    modelCountStatus: "catalog" | "verified"
  }

  export interface VerifyAuthResult {
    ok: boolean
    modelCount: number
    message?: string
    error?: string
  }

  export interface ValidateResult {
    valid: boolean
    config?: Config.Info
    providers?: string[]
    roles?: Record<string, string>
    warnings: string[]
    coreValidation?: RequiredCoreValidationResult
  }

  export interface IdentityModelInput {
    baseURL: string
    apiKey: string
    model: string
  }

  export type CustomProviderAdapter =
    | "openai-compatible"
    | "anthropic"
    | "google"
    | "openai"
    | "azure"
    | "groq"
    | "mistral"
    | "xai"

  export type CustomProviderCredentialMode = "synergy" | "env" | "inline"

  export interface CustomProviderModelDraft {
    key: string
    id: string
    name: string
    family?: string
    reasoning?: boolean
    attachment?: boolean
    tool_call?: boolean
    temperature?: boolean
    interleaved?: boolean
    status?: string
    release_date?: string
    modalities?: {
      input?: string[]
      output?: string[]
    }
    limit?: {
      context?: number
      input?: number
      output?: number
    }
    cost?: {
      input?: number
      output?: number
      cache_read?: number
      cache_write?: number
    }
    headers?: Record<string, string>
    options?: Record<string, unknown>
  }

  export interface CustomProviderDraft {
    id: string
    name: string
    adapter: CustomProviderAdapter
    npm?: string
    api: string
    env: string[]
    options?: Record<string, unknown>
    credentialMode: CustomProviderCredentialMode
    apiKey?: string
    models: CustomProviderModelDraft[]
  }

  export interface CustomProviderPreviewResult {
    providerID: string
    config: Config.Provider
    auth: { source: CustomProviderCredentialMode; env: string[]; savedInSynergy: boolean; inline: boolean }
    discoveredModels: Array<{ id: string; name: string }>
  }

  export interface CustomProviderVerifyResult {
    ok: boolean
    modelCount: number
    models: Array<{ id: string; name: string }>
    message?: string
    error?: string
    preview?: CustomProviderPreviewResult
  }

  export interface StagedAuthChange {
    mode: "set" | "remove"
    key?: string
  }

  export interface SetupDraft {
    model?: string
    vision_model?: string
    embedding?: IdentityModelInput
    rerank?: IdentityModelInput
    nano_model?: string
    mini_model?: string
    mid_model?: string
    thinking_model?: string
    long_context_model?: string
    creative_model?: string
    holos_friend_reply_model?: string
    provider?: Record<string, Config.Provider>
    auth?: Record<string, StagedAuthChange>
  }

  export type RequiredCoreField = "model" | "vision_model" | "embedding" | "rerank"

  export type ValidationMode = "static" | "live" | "catalog" | "unsupported"

  export interface FieldValidationResult {
    valid: boolean
    message: string
    mode?: ValidationMode
    latencyMs?: number
  }

  export interface RequiredCoreValidationResult {
    valid: boolean
    fields: Record<RequiredCoreField, FieldValidationResult>
  }

  interface LiveProbeOptions {
    rerank?: "best-effort" | "skip"
  }

  interface ImportProbeContext {
    config: Config.Info
    auth?: Record<string, StagedAuthChange>
  }

  interface LanguageProbeTarget {
    ref: string
    model: Provider.Model
    runtimeModel: Awaited<ReturnType<typeof Provider.getLanguage>>
  }

  interface ImportedProviderModelTarget {
    provider: Provider.Info
    model: Provider.Model
  }

  export async function init() {
    await ModelsDev.refresh().catch(() => {})
  }

  export async function getAvailableProviders(): Promise<ProviderInfo[]> {
    const database = await ModelsDev.get()
    const priority: Record<string, number> = {
      anthropic: 0,
      openai: 1,
      google: 2,
      "github-copilot": 3,
      openrouter: 4,
      vercel: 5,
      xai: 6,
      groq: 7,
      mistral: 8,
    }
    return Object.values(database)
      .map((p) => ({
        id: p.id,
        name: p.name,
        env: p.env,
      }))
      .sort((a, b) => (priority[a.id] ?? 99) - (priority[b.id] ?? 99) || a.name.localeCompare(b.name))
  }

  export async function getConnectedProviders(
    stagedAuth?: Record<string, StagedAuthChange>,
    stagedProviders?: Record<string, Config.Provider>,
  ): Promise<ConnectedProvider[]> {
    const auth = await Auth.all()
    const providers = await Provider.list()
    const currentConfig = await Config.globalRaw()
    const database = await ModelsDev.get()
    const knownProviders = new Set(Object.keys(database))
    const configuredProviders = currentConfig.provider ?? {}
    const result: ConnectedProvider[] = []
    const seen = new Set<string>()

    const runtimeModelInfo = (provider: Provider.Info): ModelInfo[] =>
      Object.values(provider.models)
        .filter((model) => model.status !== "deprecated")
        .map((model) => ({
          id: model.id,
          name: model.name,
          context: model.limit.context,
          reasoning: model.capabilities.reasoning,
          multimodal: model.capabilities.input.image || model.capabilities.input.video || model.capabilities.input.pdf,
        }))

    const configModelInfo = (provider: Config.Provider): ModelInfo[] =>
      Object.entries(provider.models ?? {})
        .filter(([, model]) => model.status !== "deprecated")
        .map(([modelID, model]) => ({
          id: model.id || modelID,
          name: model.name || modelID,
          context: model.limit?.context ?? 0,
          reasoning: Boolean(model.reasoning),
          multimodal: Boolean(
            model.modalities?.input?.includes("image") ||
              model.modalities?.input?.includes("video") ||
              model.modalities?.input?.includes("pdf"),
          ),
        }))

    const databaseModelInfo = (provider: ModelsDev.Provider): ModelInfo[] =>
      Object.values(provider.models)
        .filter((model) => model.status !== "deprecated")
        .map((model) => ({
          id: model.id,
          name: model.name,
          context: model.limit.context,
          reasoning: model.reasoning,
          multimodal: Boolean(model.modalities?.input?.some((x) => x === "image" || x === "video" || x === "pdf")),
        }))

    const getSource = (providerID: string): ConnectedProvider["source"] => {
      if (configuredProviders[providerID] || stagedProviders?.[providerID]) {
        return knownProviders.has(providerID) ? "override" : "custom"
      }
      return "builtin"
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      const staged = stagedAuth?.[providerID]
      const env = provider.env.filter((key) => Boolean(resolveEnvKey(key)))
      const providerOptions = (provider.options ?? {}) as Record<string, unknown>
      const hasInlineKey = typeof providerOptions.apiKey === "string" && providerOptions.apiKey.length > 0
      const sources: ConnectedProviderSource[] = []

      if (staged?.mode === "set" || auth[providerID]?.type === "api") {
        sources.push({ kind: "stored-key", removable: true })
      }
      if (env.length > 0) {
        sources.push({ kind: "env", removable: false, env })
      }
      if (hasInlineKey) {
        sources.push({ kind: "inline-key", removable: false })
      }
      if (stagedProviders?.[providerID]) {
        sources.push({ kind: "draft-config", removable: true })
      }

      if (staged?.mode === "remove") {
        const nextSources = sources.filter((source) => source.kind !== "stored-key")
        sources.length = 0
        sources.push(...nextSources)
      }

      if (sources.length === 0) continue

      const models = runtimeModelInfo(provider)
      result.push({
        id: providerID,
        name: provider.name,
        source: getSource(providerID),
        sources,
        models,
        catalogModelCount: models.length,
        modelCountStatus: "catalog",
      })
      seen.add(providerID)
    }

    const stagedOnlyIDs = new Set<string>([
      ...Object.keys(stagedProviders ?? {}),
      ...Object.entries(stagedAuth ?? {})
        .filter(([, change]) => change.mode === "set")
        .map(([providerID]) => providerID),
    ])

    for (const providerID of stagedOnlyIDs) {
      if (seen.has(providerID)) continue

      const stagedProvider = stagedProviders?.[providerID]
      const staged = stagedAuth?.[providerID]
      const sources: ConnectedProviderSource[] = []

      if (staged?.mode === "set") {
        sources.push({ kind: "stored-key", removable: true })
      }
      if (stagedProvider) {
        sources.push({ kind: "draft-config", removable: true })
      }
      if (sources.length === 0) continue

      const dbProvider = database[providerID]
      const models = stagedProvider ? configModelInfo(stagedProvider) : dbProvider ? databaseModelInfo(dbProvider) : []
      if (!stagedProvider && !dbProvider) continue

      result.push({
        id: providerID,
        name: stagedProvider?.name || dbProvider?.name || providerID,
        source: getSource(providerID),
        sources,
        models,
        catalogModelCount: models.length,
        modelCountStatus: "catalog",
      })
    }

    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async function fetchOpenAICompatibleModels(baseURL: string, apiKey: string) {
    const url = baseURL.replace(/\/+$/, "") + "/models"
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []

    const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
    if (!data.data) return []
    return data.data.map((item) => ({ id: item.id, name: item.name ?? item.id }))
  }

  export async function discoverModels(input: {
    baseURL: string
    apiKey: string
    type?: "embedding" | "rerank"
  }): Promise<Array<{ id: string; name: string; type: "embedding" | "rerank" }>> {
    try {
      const available = await fetchOpenAICompatibleModels(input.baseURL, input.apiKey)
      const results: Array<{ id: string; name: string; type: "embedding" | "rerank" }> = []
      for (const m of available) {
        const id = m.id.toLowerCase()
        const isEmbed = id.includes("embed") || id.includes("bge") || id.includes("gte")
        const isRerank = id.includes("rerank")
        if (!isEmbed && !isRerank) continue
        const type = isRerank ? ("rerank" as const) : ("embedding" as const)
        if (input.type && type !== input.type) continue
        results.push({ id: m.id, name: m.name, type })
      }
      return results
    } catch {
      return []
    }
  }

  const ADAPTER_PACKAGE: Record<CustomProviderAdapter, string> = {
    "openai-compatible": "@ai-sdk/openai-compatible",
    anthropic: "@ai-sdk/anthropic",
    google: "@ai-sdk/google",
    openai: "@ai-sdk/openai",
    azure: "@ai-sdk/azure",
    groq: "@ai-sdk/groq",
    mistral: "@ai-sdk/mistral",
    xai: "@ai-sdk/xai",
  }

  interface VerifyEndpoint {
    url: string
    headers: (key: string) => Record<string, string>
  }

  const KNOWN_VERIFY_ENDPOINTS: Record<string, VerifyEndpoint> = {
    openai: {
      url: "https://api.openai.com/v1/models",
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    },
    anthropic: {
      url: "https://api.anthropic.com/v1/models",
      headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    },
    google: {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headers: () => ({}),
    },
    groq: {
      url: "https://api.groq.com/openai/v1/models",
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    },
    mistral: {
      url: "https://api.mistral.ai/v1/models",
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    },
    xai: {
      url: "https://api.x.ai/v1/models",
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    },
  }

  function headersForSDK(npm: string | undefined, key: string): Record<string, string> {
    if (npm === "@ai-sdk/anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" }
    return { Authorization: `Bearer ${key}` }
  }

  async function verifyApiKey(
    providerID: string,
    provider: { api?: string; npm?: string } | undefined,
    key: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const known = KNOWN_VERIFY_ENDPOINTS[providerID]

    let url: string
    let headers: Record<string, string>

    if (known) {
      url = providerID === "google" ? `${known.url}?key=${key}` : known.url
      headers = known.headers(key)
    } else if (provider?.api) {
      url = provider.api.replace(/\/+$/, "") + "/models"
      headers = headersForSDK(provider.npm, key)
    } else {
      return { ok: true }
    }

    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return { ok: true }
      if (res.status === 404) return { ok: true }
      const body = await res.text().catch(() => "")
      const msg =
        res.status === 401 || res.status === 403
          ? "Invalid API key"
          : `API responded with ${res.status}${body ? ": " + body.slice(0, 200) : ""}`
      return { ok: false, error: msg }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to reach API",
      }
    }
  }

  export async function verifyAuth(providerID: string, key: string): Promise<VerifyAuthResult> {
    const database = await ModelsDev.get()
    const provider = database[providerID]

    const verify = await verifyApiKey(providerID, provider, key)
    if (!verify.ok) {
      return { ok: false, modelCount: 0, error: verify.error }
    }

    const modelCount = provider ? Object.keys(provider.models).length : 0
    return {
      ok: true,
      modelCount,
      message: modelCount > 0 ? `Verified successfully (${modelCount} models available)` : "Verified successfully",
    }
  }

  async function reloadProviderConfigState() {
    try {
      await RuntimeReload.reload({
        targets: ["config"],
        scope: "global",
        reason: "config-ui-setup-commit",
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes("No context found for instance")) {
        return
      }
      throw error
    }
  }

  export async function removeAuth(providerID: string): Promise<void> {
    await Auth.remove(providerID)
    await reloadProviderConfigState()
  }

  export async function saveAuth(providerID: string, key: string): Promise<void> {
    await Auth.set(providerID, { type: "api", key })
    await reloadProviderConfigState()
  }

  function normalizeProviderID(value: string) {
    return value.trim()
  }

  function cleanRecord(value?: Record<string, unknown>) {
    if (!value) return undefined
    const out = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""))
    return Object.keys(out).length > 0 ? out : undefined
  }

  function buildCustomProviderConfig(draft: CustomProviderDraft): Config.Provider {
    const models: NonNullable<Config.Provider["models"]> = Object.fromEntries(
      draft.models.map((model) => {
        const inputModalities = (model.modalities?.input ?? []).filter(Boolean) as Array<
          "text" | "audio" | "image" | "video" | "pdf"
        >
        const outputModalities = (model.modalities?.output ?? []).filter(Boolean) as Array<
          "text" | "audio" | "image" | "video" | "pdf"
        >
        const entry: NonNullable<Config.Provider["models"]>[string] = {
          id: model.id,
          name: model.name,
          family: model.family,
          reasoning: model.reasoning,
          attachment: model.attachment,
          tool_call: model.tool_call,
          temperature: model.temperature,
          interleaved: model.interleaved ? true : undefined,
          status:
            model.status === "alpha" || model.status === "beta" || model.status === "deprecated"
              ? model.status
              : undefined,
          release_date: model.release_date,
          modalities:
            inputModalities.length > 0 && outputModalities.length > 0
              ? {
                  input: inputModalities,
                  output: outputModalities,
                }
              : undefined,
          limit:
            model.limit?.context !== undefined && model.limit?.output !== undefined
              ? {
                  context: model.limit.context,
                  input: model.limit?.input,
                  output: model.limit.output,
                }
              : undefined,
          cost:
            model.cost?.input !== undefined && model.cost?.output !== undefined
              ? {
                  input: model.cost.input,
                  output: model.cost.output,
                  cache_read: model.cost.cache_read,
                  cache_write: model.cost.cache_write,
                }
              : undefined,
          headers: model.headers,
          options: cleanRecord(model.options),
        }
        return [model.key, entry] as const
      }),
    )

    const options = {
      ...(draft.api ? { baseURL: draft.api } : {}),
      ...cleanRecord(draft.options),
      ...(draft.credentialMode === "inline" && draft.apiKey ? { apiKey: draft.apiKey } : {}),
    }

    return {
      api: draft.api,
      name: draft.name,
      env: draft.env,
      npm: draft.npm ?? ADAPTER_PACKAGE[draft.adapter],
      options: Object.keys(options).length > 0 ? options : undefined,
      models,
    }
  }

  export async function previewCustomProvider(draft: CustomProviderDraft): Promise<CustomProviderPreviewResult> {
    const providerID = normalizeProviderID(draft.id)
    if (!providerID) throw new Error("Provider ID is required")
    if (!draft.name.trim()) throw new Error("Provider name is required")
    if (!draft.api.trim()) throw new Error("Provider API base URL is required")
    if (draft.models.length === 0) throw new Error("At least one model is required")
    for (const model of draft.models) {
      if (!model.key.trim()) throw new Error("Each model needs a config key")
      if (!model.id.trim()) throw new Error(`Model \"${model.key || model.name || "(unnamed)"}\" needs an API model id`)
      if (!model.name.trim()) throw new Error(`Model \"${model.key || model.id}\" needs a display name`)
    }

    const seenKeys = new Set<string>()
    for (const model of draft.models) {
      if (seenKeys.has(model.key)) throw new Error(`Duplicate model key \"${model.key}\"`)
      seenKeys.add(model.key)
    }

    const discoveredModels = draft.apiKey
      ? await fetchOpenAICompatibleModels(draft.api, draft.apiKey).catch(() => [])
      : []

    return {
      providerID,
      config: buildCustomProviderConfig({ ...draft, id: providerID }),
      auth: {
        source: draft.credentialMode,
        env: draft.env,
        savedInSynergy: draft.credentialMode === "synergy",
        inline: draft.credentialMode === "inline",
      },
      discoveredModels,
    }
  }

  export async function verifyCustomProvider(draft: CustomProviderDraft): Promise<CustomProviderVerifyResult> {
    const preview = await previewCustomProvider(draft)
    if (draft.credentialMode !== "env" && !draft.apiKey) {
      return {
        ok: false,
        modelCount: 0,
        models: [],
        error: "API key is required unless using environment-variable-only mode",
        preview,
      }
    }

    if (draft.credentialMode === "env") {
      return {
        ok: true,
        modelCount: 0,
        models: [],
        message: "Saved in environment-variable mode without live verification",
        preview,
      }
    }

    const key = draft.apiKey ?? ""
    const npm = draft.npm ?? ADAPTER_PACKAGE[draft.adapter]
    const verify = await verifyApiKey(preview.providerID, { api: draft.api, npm }, key)
    const models = draft.apiKey ? await fetchOpenAICompatibleModels(draft.api, draft.apiKey).catch(() => []) : []
    if (!verify.ok) {
      return { ok: false, modelCount: models.length, models, error: verify.error, preview }
    }
    return {
      ok: true,
      modelCount: models.length,
      models,
      message:
        models.length > 0 ? `Verified successfully (${models.length} models available)` : "Verified successfully",
      preview,
    }
  }

  const CONFIG_SCHEMA = Global.Path.configSchemaUrl

  const MODEL_KEYS = [
    "model",
    "vision_model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "holos_friend_reply_model",
  ] as const

  const ROLE_KEYS = [
    "model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "holos_friend_reply_model",
    "vision_model",
  ] as const

  function now() {
    return performance.now()
  }

  function withTiming(startedAt: number, result: Omit<FieldValidationResult, "latencyMs">): FieldValidationResult {
    return {
      ...result,
      latencyMs: Math.round(now() - startedAt),
    }
  }

  function summarizeValidation(fields: Record<RequiredCoreField, FieldValidationResult>): RequiredCoreValidationResult {
    return {
      valid: Object.values(fields).every((field) => field.valid),
      fields,
    }
  }

  function extractIdentityInputs(config: SetupDraft | Config.Info) {
    const draft = config as SetupDraft
    const info = config as Config.Info

    const embedding =
      draft.embedding ??
      (info.identity?.embedding?.baseURL && info.identity.embedding.apiKey && info.identity.embedding.model
        ? {
            baseURL: info.identity.embedding.baseURL,
            apiKey: info.identity.embedding.apiKey,
            model: info.identity.embedding.model,
          }
        : undefined)

    const rerank =
      draft.rerank ??
      (info.identity?.rerank?.baseURL && info.identity.rerank.apiKey && info.identity.rerank.model
        ? {
            baseURL: info.identity.rerank.baseURL,
            apiKey: info.identity.rerank.apiKey,
            model: info.identity.rerank.model,
          }
        : undefined)

    return { embedding, rerank }
  }

  async function resolveContextProviderModel(
    config: Pick<Config.Info, "provider">,
    ref: string,
  ): Promise<ImportedProviderModelTarget> {
    const { providerID, modelID } = Provider.parseModel(ref)
    const database = await ModelsDev.get()
    const imported = config.provider?.[providerID]
    const base = database[providerID]

    if (!imported && !base) {
      throw new Error(`Provider \"${providerID}\" was not found in the imported config or known provider catalog`)
    }

    const existing = base ? Provider.fromModelsDevProvider(base) : undefined
    const configModel = imported?.models?.[modelID]
    const existingModel = existing?.models[modelID]

    if (!configModel && !existingModel) {
      throw new Error(`Model \"${ref}\" was not found in the imported provider config or known provider catalog`)
    }

    const model: Provider.Model = {
      id: modelID,
      providerID,
      name: configModel?.name ?? existingModel?.name ?? modelID,
      family: configModel?.family ?? existingModel?.family ?? "",
      api: {
        id: configModel?.id ?? existingModel?.api.id ?? modelID,
        npm:
          configModel?.provider?.npm ??
          imported?.npm ??
          existingModel?.api.npm ??
          base?.npm ??
          "@ai-sdk/openai-compatible",
        url: imported?.api ?? existingModel?.api.url ?? base?.api ?? "",
      },
      status: configModel?.status ?? existingModel?.status ?? "active",
      headers: mergeDeep(existingModel?.headers ?? {}, configModel?.headers ?? {}),
      options: mergeDeep(existingModel?.options ?? {}, configModel?.options ?? {}),
      cost: {
        input: configModel?.cost?.input ?? existingModel?.cost.input ?? 0,
        output: configModel?.cost?.output ?? existingModel?.cost.output ?? 0,
        cache: {
          read: configModel?.cost?.cache_read ?? existingModel?.cost.cache.read ?? 0,
          write: configModel?.cost?.cache_write ?? existingModel?.cost.cache.write ?? 0,
        },
      },
      limit: {
        context: configModel?.limit?.context ?? existingModel?.limit.context ?? 0,
        input: configModel?.limit?.input ?? existingModel?.limit.input,
        output: configModel?.limit?.output ?? existingModel?.limit.output ?? 0,
      },
      capabilities: {
        temperature: configModel?.temperature ?? existingModel?.capabilities.temperature ?? false,
        reasoning: configModel?.reasoning ?? existingModel?.capabilities.reasoning ?? false,
        attachment: configModel?.attachment ?? existingModel?.capabilities.attachment ?? false,
        toolcall: configModel?.tool_call ?? existingModel?.capabilities.toolcall ?? true,
        input: {
          text: configModel?.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
          audio: configModel?.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
          image: configModel?.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
          video: configModel?.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
          pdf: configModel?.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
        },
        output: {
          text: configModel?.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
          audio:
            configModel?.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
          image:
            configModel?.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
          video:
            configModel?.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
          pdf: configModel?.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
        },
        interleaved: configModel?.interleaved ?? existingModel?.capabilities.interleaved ?? false,
      },
      release_date: configModel?.release_date ?? existingModel?.release_date ?? "",
      variants: existingModel?.variants ?? {},
    }

    const provider: Provider.Info = {
      id: providerID,
      name: imported?.name ?? existing?.name ?? providerID,
      source: "config",
      env: imported?.env ?? existing?.env ?? [],
      key: undefined,
      options: mergeDeep(existing?.options ?? {}, imported?.options ?? {}),
      models: {
        ...(existing?.models ?? {}),
        [modelID]: model,
      },
    }

    return { provider, model }
  }

  async function resolveImportedProviderModel(config: Config.Info, ref: string): Promise<ImportedProviderModelTarget> {
    return resolveContextProviderModel(config, ref)
  }

  async function resolveLanguageProbeTarget(
    value: string,
    importContext?: ImportProbeContext,
  ): Promise<LanguageProbeTarget> {
    const { providerID, modelID } = Provider.parseModel(value)
    const model = await Provider.getModel(providerID, modelID)
    const provider = await Provider.getProvider(providerID)

    if (provider && !provider.key && provider.source !== "custom") {
      const apiKey = await resolveProviderAPIKey(provider, model)
      if (!apiKey) {
        throw new Error(`No API key found for provider "${providerID}".` + providerEnvHint(provider))
      }
    }

    return {
      ref: value,
      model,
      runtimeModel: await Provider.getLanguage(model),
    }
  }

  async function resolveProbeModelTarget(value: string, importContext?: ImportProbeContext) {
    if (importContext) {
      return resolveImportedProviderModel(importContext.config, value)
    }
    return resolveLanguageProbeTarget(value)
  }

  async function verifyLanguageModel(
    value: string,
    options?: { requireMultimodal?: boolean; label?: string; importContext?: ImportProbeContext },
  ): Promise<FieldValidationResult> {
    const startedAt = now()
    const label = options?.label ?? "Model"
    try {
      const target = await resolveProbeModelTarget(value, options?.importContext)

      if (options?.requireMultimodal) {
        const supportsVision =
          target.model.capabilities.input.image ||
          target.model.capabilities.input.video ||
          target.model.capabilities.input.pdf
        if (!supportsVision) {
          return withTiming(startedAt, {
            valid: false,
            mode: "static",
            message: `${label} must support image, PDF, or video input`,
          })
        }
      }

      return withTiming(startedAt, {
        valid: true,
        mode: "static",
        message: `${label} verified`,
      })
    } catch (error) {
      return withTiming(startedAt, {
        valid: false,
        mode: "static",
        message: error instanceof Error ? error.message : `${label} could not be verified`,
      })
    }
  }

  async function verifyIdentityModel(
    input: IdentityModelInput,
    type: "embedding" | "rerank",
  ): Promise<FieldValidationResult> {
    const startedAt = now()
    if (!input.baseURL || !input.apiKey || !input.model) {
      return withTiming(startedAt, {
        valid: false,
        mode: "catalog",
        message: `${type} baseURL, apiKey, and model are required`,
      })
    }

    const models = await discoverModels({
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      type,
    })

    if (models.length === 0) {
      return withTiming(startedAt, {
        valid: false,
        mode: "catalog",
        message: `Could not verify ${type} model from ${input.baseURL}`,
      })
    }

    const matched = models.find((item) => item.id === input.model || item.name === input.model)
    if (!matched) {
      return withTiming(startedAt, {
        valid: false,
        mode: "catalog",
        message: `${type} model \"${input.model}\" was not found at ${input.baseURL}`,
      })
    }

    return withTiming(startedAt, {
      valid: true,
      mode: "catalog",
      message: `${type} model verified`,
    })
  }

  function resolveEnvKey(key: string): string | undefined {
    try {
      return Env.get(key)
    } catch {
      return process.env[key]
    }
  }

  function providerEnvHint(provider: { env?: string[] }) {
    return provider.env && provider.env.length > 0 ? ` Expected env: ${provider.env.join(", ")}.` : ""
  }

  async function resolveProviderAPIKey(
    provider: Pick<Provider.Info, "id" | "env" | "options">,
    model?: Pick<Provider.Model, "options">,
    authChanges?: Record<string, StagedAuthChange>,
  ): Promise<string | undefined> {
    const stagedAuth = authChanges?.[provider.id]
    const auth = stagedAuth?.mode === "set" ? { key: stagedAuth.key } : await Auth.get(provider.id)
    const modelOptions = (model?.options ?? {}) as Record<string, unknown>
    const providerOptions = (provider.options ?? {}) as Record<string, unknown>
    return (
      (auth && "key" in auth ? auth.key : undefined) ??
      (modelOptions.apiKey as string | undefined) ??
      (providerOptions.apiKey as string | undefined) ??
      provider.env.map((key) => resolveEnvKey(key)).find(Boolean)
    )
  }

  async function createImportedLanguageRuntime(
    target: ImportedProviderModelTarget,
    authChanges?: Record<string, StagedAuthChange>,
  ) {
    const modelOptions = (target.model.options ?? {}) as Record<string, unknown>
    const providerOptions = (target.provider.options ?? {}) as Record<string, unknown>
    const apiKey = await resolveProviderAPIKey(target.provider, target.model, authChanges)

    if (!apiKey) {
      throw new Error(
        `No API key found for provider "${target.provider.id}".` +
          providerEnvHint(target.provider) +
          ` Add an "apiKey" in the provider's "options", save the provider connection, or set one of the provider environment variables.`,
      )
    }

    const sdk = Provider.createSDKFromSpec(target.model, {
      options: { ...providerOptions, ...modelOptions, apiKey },
      key: apiKey,
    })

    return sdk.languageModel(target.model.api.id)
  }

  async function probeLanguageModel(
    value: string,
    options?: { requireMultimodal?: boolean; label?: string; importContext?: ImportProbeContext },
  ): Promise<FieldValidationResult> {
    const startedAt = now()
    const label = options?.label ?? "Model"

    try {
      const target = await resolveProbeModelTarget(value, options?.importContext)
      const model = target.model
      const runtimeModel =
        "runtimeModel" in target
          ? target.runtimeModel
          : await createImportedLanguageRuntime(target, options?.importContext?.auth)
      const providerOptions = ProviderTransform.providerOptions(model, ProviderTransform.smallOptions(model))

      const messages: ModelMessage[] = options?.requireMultimodal
        ? [
            {
              role: "user",
              content: [
                { type: "text", text: "Reply with OK only if you can read the attached image." },
                {
                  type: "image",
                  image:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
                },
              ],
            },
          ]
        : [{ role: "user", content: [{ type: "text", text: "Reply with OK only." }] }]

      const transformed = ProviderTransform.message(messages, model)

      await generateText({
        model: runtimeModel,
        messages: transformed,
        maxOutputTokens: 8,
        temperature: 0,
        providerOptions,
        abortSignal: AbortSignal.timeout(options?.requireMultimodal ? 60_000 : 12_000),
      })

      return withTiming(startedAt, {
        valid: true,
        mode: "live",
        message: options?.requireMultimodal
          ? `${label} passed a multimodal live probe`
          : `${label} passed a live probe`,
      })
    } catch (error) {
      const raw = error instanceof Error ? error.message : `${label} failed the live probe`
      const message = formatProbeError(raw, value, label)
      return withTiming(startedAt, {
        valid: false,
        mode: "live",
        message,
      })
    }
  }

  function formatProbeError(raw: string, modelRef: string, label: string): string {
    const { providerID } = Provider.parseModel(modelRef)
    if (raw.includes("No API key found for provider")) {
      return `${label} probe failed: ${raw}`
    }
    if (raw.includes("No context found for instance")) {
      return `${label} probe failed: Config UI backend lost its scope context while loading provider \"${providerID}\". Retry from the current project scope.`
    }
    if (raw.includes("No context found")) {
      return `${label} probe failed for provider \"${providerID}\": runtime context was unavailable while resolving the model.`
    }

    if (raw.includes("401") || raw.includes("Unauthorized") || raw.includes("authentication")) {
      return `${label} probe failed: authentication error for provider "${providerID}". Check that the API key is correct.`
    }
    if (raw.includes("ECONNREFUSED") || raw.includes("ENOTFOUND") || raw.includes("fetch failed")) {
      return `${label} probe failed: could not connect to provider "${providerID}" API endpoint. Check the baseURL is reachable.`
    }
    if (raw.includes("timeout") || raw.includes("aborted")) {
      return `${label} probe timed out for provider "${providerID}". The API endpoint did not respond within 12 seconds.`
    }
    return `${label} probe failed for "${modelRef}": ${raw}`
  }

  async function probeEmbeddingModel(input: IdentityModelInput): Promise<FieldValidationResult> {
    const startedAt = now()
    if (!input.baseURL || !input.apiKey || !input.model) {
      return withTiming(startedAt, {
        valid: false,
        mode: "live",
        message: "Embedding configuration is required",
      })
    }

    try {
      const sdk = createOpenAICompatible({
        name: "config-embedding-probe",
        apiKey: input.apiKey,
        baseURL: input.baseURL,
      })
      const model = sdk.textEmbeddingModel(input.model)
      const result = await embed({
        model,
        value: "ping",
        abortSignal: AbortSignal.timeout(12_000),
      })

      if (!result.embedding || result.embedding.length === 0) {
        return withTiming(startedAt, {
          valid: false,
          mode: "live",
          message: `Embedding probe returned no vector for \"${input.model}\"`,
        })
      }

      return withTiming(startedAt, {
        valid: true,
        mode: "live",
        message: `Embedding model passed a live probe`,
      })
    } catch (error) {
      return withTiming(startedAt, {
        valid: false,
        mode: "live",
        message: error instanceof Error ? error.message : `Embedding probe failed`,
      })
    }
  }

  async function probeRerankModel(input: IdentityModelInput): Promise<FieldValidationResult> {
    const startedAt = now()
    const baseURL = input.baseURL.replace(/\/+$/, "")

    if (!input.baseURL || !input.apiKey || !input.model) {
      return withTiming(startedAt, {
        valid: false,
        mode: "live",
        message: "Rerank configuration is required",
      })
    }

    try {
      const body = {
        model: input.model,
        query: "ping",
        documents: ["alpha", "beta"],
        top_n: 1,
      }

      const endpoints = ["/rerank", "/v1/rerank"]
      let lastError = ""

      for (const endpoint of endpoints) {
        const response = await fetch(baseURL + endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(12_000),
        }).catch((error) => {
          lastError = error instanceof Error ? error.message : String(error)
          return undefined
        })

        if (!response) continue
        if (response.ok) {
          return withTiming(startedAt, {
            valid: true,
            mode: "live",
            message: "Rerank model passed a live probe",
          })
        }

        const text = await response.text().catch(() => "")
        lastError = `${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`
        if (response.status !== 404) {
          return withTiming(startedAt, {
            valid: false,
            mode: "live",
            message: `Rerank probe failed (${lastError})`,
          })
        }
      }

      return withTiming(startedAt, {
        valid: false,
        mode: "unsupported",
        message: lastError
          ? `Real rerank probe is not supported by this endpoint (${lastError})`
          : "Real rerank probe is not supported by this endpoint",
      })
    } catch (error) {
      return withTiming(startedAt, {
        valid: false,
        mode: "live",
        message: error instanceof Error ? error.message : `Rerank probe failed`,
      })
    }
  }

  function requiredMissing(message: string): FieldValidationResult {
    return { valid: false, message, mode: "static" }
  }

  function recommendedSkipped(message: string): FieldValidationResult {
    return { valid: true, message, mode: "static" }
  }

  export async function validateRequiredCore(config: SetupDraft): Promise<RequiredCoreValidationResult> {
    const { embedding, rerank } = extractIdentityInputs(config)
    const context: ImportProbeContext = { config: applySetupDraft({}, config), auth: config.auth }
    const fields: Record<RequiredCoreField, FieldValidationResult> = {
      model: config.model
        ? await verifyLanguageModel(config.model, { label: "Default model", importContext: context })
        : requiredMissing("Default model is required"),
      vision_model: config.vision_model
        ? await verifyLanguageModel(config.vision_model, {
            label: "Vision model",
            requireMultimodal: true,
            importContext: context,
          })
        : requiredMissing("Vision model is required"),
      embedding: embedding
        ? await verifyIdentityModel(embedding, "embedding")
        : recommendedSkipped("Skipped — memory evolution will be disabled"),
      rerank: rerank
        ? await verifyIdentityModel(rerank, "rerank")
        : recommendedSkipped("Skipped — memory evolution will be disabled"),
    }

    return summarizeValidation(fields)
  }

  export async function probeRequiredCore(
    config: SetupDraft,
    options: LiveProbeOptions = {},
  ): Promise<RequiredCoreValidationResult> {
    const { embedding, rerank } = extractIdentityInputs(config)
    const context: ImportProbeContext = { config: applySetupDraft({}, config), auth: config.auth }
    const [model, visionModel, embeddingProbe, rerankProbe] = await Promise.all([
      config.model
        ? probeLanguageModel(config.model, { label: "Default model", importContext: context })
        : Promise.resolve(requiredMissing("Default model is required")),
      config.vision_model
        ? probeLanguageModel(config.vision_model, {
            label: "Vision model",
            requireMultimodal: true,
            importContext: context,
          })
        : Promise.resolve(requiredMissing("Vision model is required")),
      embedding
        ? probeEmbeddingModel(embedding)
        : Promise.resolve(recommendedSkipped("Skipped — memory evolution will be disabled")),
      rerank
        ? options.rerank === "skip"
          ? Promise.resolve({
              valid: true,
              mode: "unsupported" as const,
              message: "Rerank live probe skipped",
            })
          : probeRerankModel(rerank)
        : Promise.resolve(recommendedSkipped("Skipped — memory evolution will be disabled")),
    ])

    return summarizeValidation({
      model,
      vision_model: visionModel,
      embedding: embeddingProbe,
      rerank: rerankProbe,
    })
  }

  async function validateImportedCore(config: Config.Info): Promise<RequiredCoreValidationResult> {
    const { embedding, rerank } = extractIdentityInputs(config)
    const [model, visionModel, embeddingValidation, rerankValidation] = await Promise.all([
      config.model
        ? verifyLanguageModel(config.model, { label: "Default model", importContext: { config } })
        : Promise.resolve(requiredMissing("Default model is required")),
      config.vision_model
        ? verifyLanguageModel(config.vision_model, {
            label: "Vision model",
            requireMultimodal: true,
            importContext: { config },
          })
        : Promise.resolve(requiredMissing("Vision model is required")),
      embedding
        ? verifyIdentityModel(embedding, "embedding")
        : Promise.resolve(recommendedSkipped("Skipped — memory evolution will be disabled")),
      rerank
        ? verifyIdentityModel(rerank, "rerank")
        : Promise.resolve(recommendedSkipped("Skipped — memory evolution will be disabled")),
    ])

    return summarizeValidation({
      model,
      vision_model: visionModel,
      embedding: embeddingValidation,
      rerank: rerankValidation,
    })
  }

  export async function probeImportedCore(
    config: Config.Info,
    options: LiveProbeOptions = {},
  ): Promise<RequiredCoreValidationResult> {
    const { embedding, rerank } = extractIdentityInputs(config)
    const [model, visionModel, embeddingProbe, rerankProbe] = await Promise.all([
      config.model
        ? probeLanguageModel(config.model, { label: "Default model", importContext: { config } })
        : Promise.resolve(requiredMissing("Default model is required")),
      config.vision_model
        ? probeLanguageModel(config.vision_model, {
            label: "Vision model",
            requireMultimodal: true,
            importContext: { config },
          })
        : Promise.resolve(requiredMissing("Vision model is required")),
      embedding
        ? probeEmbeddingModel(embedding)
        : Promise.resolve(recommendedSkipped("Skipped — memory evolution will be disabled")),
      rerank
        ? options.rerank === "skip"
          ? Promise.resolve({
              valid: true,
              mode: "unsupported" as const,
              message: "Rerank live probe skipped",
            })
          : probeRerankModel(rerank)
        : Promise.resolve(recommendedSkipped("Skipped — memory evolution will be disabled")),
    ])

    return summarizeValidation({
      model,
      vision_model: visionModel,
      embedding: embeddingProbe,
      rerank: rerankProbe,
    })
  }

  function applySetupDraft(base: Config.Info, draft: SetupDraft): Config.Info {
    const next: Config.Info = {
      ...base,
      $schema: base.$schema ?? CONFIG_SCHEMA,
    }

    for (const key of MODEL_KEYS) {
      const value = draft[key]
      if (value) next[key] = value
      else delete next[key]
    }

    const identity = { ...(base.identity ?? {}) }
    const hasEmbedding = Boolean(draft.embedding?.baseURL && draft.embedding?.apiKey && draft.embedding?.model)
    const hasRerank = Boolean(draft.rerank?.baseURL && draft.rerank?.apiKey && draft.rerank?.model)

    if (hasEmbedding) {
      identity.embedding = {
        baseURL: draft.embedding!.baseURL,
        apiKey: draft.embedding!.apiKey,
        model: draft.embedding!.model,
      }
    } else {
      delete identity.embedding
    }

    if (hasRerank) {
      identity.rerank = {
        baseURL: draft.rerank!.baseURL,
        apiKey: draft.rerank!.apiKey,
        model: draft.rerank!.model,
      }
    } else {
      delete identity.rerank
    }

    identity.evolution = hasEmbedding && hasRerank

    if (Object.keys(identity).length > 0) next.identity = identity
    else delete next.identity

    if (draft.provider) {
      const provider = { ...(base.provider ?? {}) }
      for (const [providerID, config] of Object.entries(draft.provider)) {
        provider[providerID] = config
      }
      next.provider = provider
    }

    return next
  }

  async function applyStagedAuthChanges(changes?: Record<string, StagedAuthChange>) {
    if (!changes) return
    for (const [providerID, change] of Object.entries(changes)) {
      if (change.mode === "set") {
        if (!change.key) throw new Error(`Missing API key for provider \"${providerID}\"`)
        await Auth.set(providerID, { type: "api", key: change.key })
        continue
      }
      await Auth.remove(providerID)
    }
  }

  async function writeGlobalConfigFile(config: Config.Info): Promise<string> {
    const activeSet = await ConfigSet.activeName()
    await Config.configSetUpdate(activeSet, config)
    return ConfigSet.filePath(activeSet)
  }

  export async function finalizeConfig(
    config: SetupDraft,
    validation: RequiredCoreValidationResult | undefined = undefined,
  ): Promise<{ filepath: string; validation: RequiredCoreValidationResult }> {
    const resolvedValidation = validation ?? (await probeRequiredCore(config))
    if (!resolvedValidation.valid) {
      throw new Error("Required setup validation failed")
    }

    const current = await Config.globalRaw()
    const built = applySetupDraft(current, config)
    const parsed = Config.Info.safeParse(built)
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map(formatIssue).join(", "))
    }

    const filepath = await writeGlobalConfigFile(parsed.data)
    await applyStagedAuthChanges(config.auth)
    await reloadProviderConfigState()
    return { filepath, validation: resolvedValidation }
  }

  const TOP_LEVEL_KEYS = [
    "$schema",
    "theme",
    "keybinds",
    "logLevel",
    "server",
    "command",
    "watcher",
    "plugin",
    "snapshot",
    "autoupdate",
    "disabled_providers",
    "enabled_providers",
    "model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "holos_friend_reply_model",
    "vision_model",
    "default_agent",
    "username",
    "agent",
    "provider",
    "identity",
    "mcp",
    "channel",
    "formatter",
    "lsp",
    "instructions",
    "layout",
    "permission",
    "tools",
    "enterprise",
    "agora",
    "compaction",
    "experimental",
    "category",
  ]

  function suggestKey(key: string, candidates: string[]): string | undefined {
    let best: string | undefined
    let bestScore = Infinity
    const lower = key.toLowerCase()
    for (const candidate of candidates) {
      const cl = candidate.toLowerCase()
      if (cl === lower) continue
      const d = editDistance(lower, cl)
      if (d < bestScore && d <= Math.max(2, Math.floor(lower.length * 0.4))) {
        bestScore = d
        best = candidate
      }
    }
    return best
  }

  function editDistance(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      }
    }
    return dp[m][n]
  }

  function formatIssue(issue: z.core.$ZodIssue): string {
    const location = issue.path.length > 0 ? issue.path.join(".") : undefined

    if (issue.code === "unrecognized_keys") {
      const keys = (issue as any).keys as string[]
      const parts: string[] = []
      for (const key of keys) {
        const candidates = issue.path.length === 0 ? TOP_LEVEL_KEYS : []
        const suggestion = candidates.length > 0 ? suggestKey(key, candidates) : undefined
        let msg = `"${key}"`
        if (suggestion) msg += ` (did you mean "${suggestion}"?)`
        parts.push(msg)
      }
      const prefix = location ? `In ${location}: ` : ""
      return `${prefix}Unrecognized field${keys.length > 1 ? "s" : ""}: ${parts.join(", ")}`
    }

    const prefix = location ? `${location}: ` : ""
    return `${prefix}${issue.message}`
  }

  export async function validateImport(json: unknown): Promise<ValidateResult> {
    const warnings: string[] = []

    if (typeof json !== "object" || json === null) {
      return { valid: false, warnings: ["Input must be a JSON object"] }
    }

    const parsed = Config.Info.safeParse(json)
    if (!parsed.success) {
      return {
        valid: false,
        warnings: parsed.error.issues.map(formatIssue),
      }
    }

    const config = parsed.data

    const providers: string[] = []
    if (config.provider) {
      providers.push(...Object.keys(config.provider))
    }

    const roles: Record<string, string> = {}
    for (const key of ROLE_KEYS) {
      const value = config[key]
      if (value) roles[key] = value
    }

    const coreValidation = await validateImportedCore(config)

    if (!coreValidation.valid) {
      for (const [field, result] of Object.entries(coreValidation.fields) as Array<
        [RequiredCoreField, FieldValidationResult]
      >) {
        if (!result.valid) warnings.push(result.message || `${field} is invalid`)
      }
    }

    return {
      valid: coreValidation.valid,
      config,
      providers,
      roles,
      warnings,
      coreValidation,
    }
  }

  export async function importConfig(json: unknown): Promise<string> {
    const result = await validateImport(json)
    if (!result.valid || !result.config) {
      throw new Error("Invalid config: " + result.warnings.join(", "))
    }

    const out: Record<string, unknown> = { $schema: CONFIG_SCHEMA }
    for (const [key, value] of Object.entries(result.config)) {
      if (value !== undefined && value !== null) out[key] = value
    }

    const parsed = Config.Info.safeParse(out)
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map(formatIssue).join(", "))
    }

    return writeGlobalConfigFile(parsed.data)
  }

  export async function readCurrentConfig(): Promise<Record<string, unknown>> {
    return Config.globalRaw()
  }

  /**
   * Download and parse JSON config from a URL.
   * Used by `synergy config import <url>`.
   */
  export async function downloadConfigFromURL(url: string): Promise<unknown> {
    const TIMEOUT_MS = 15_000 // 15 seconds timeout

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        throw new Error(`Config not found at URL (HTTP ${response.status})`)
      }

      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error("Invalid JSON format in downloaded config")
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "TimeoutError" || error.message.includes("timeout")) {
          throw new Error("Connection timeout while downloading config")
        }
        if (error.message.includes("HTTP")) {
          throw error // Already formatted HTTP error
        }
        if (error.message.includes("JSON")) {
          throw error // Already formatted JSON error
        }
        throw new Error(`Failed to download config from URL: ${error.message}`)
      }
      throw new Error("Failed to download config from URL: Unknown error")
    }
  }
}
