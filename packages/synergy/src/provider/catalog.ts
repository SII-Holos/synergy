import { Global } from "@/global"
import { Installation } from "@/global/installation"
import { ScopeContext } from "@/scope/context"
import { Log } from "@/util/log"
import fs from "fs/promises"
import { mergeDeep } from "remeda"
import z from "zod"
import { Auth } from "./api-key"
import { registerBuiltinProviderProfiles } from "./builtin"
import { CodexProvider } from "./codex"
import { ModelsDev } from "./models-schemas"
import { ProviderProfile } from "./profile"
import { ProviderPluginAuth } from "./plugin-auth-source"
import { normalizeImageMediaTypes } from "./image-capability"
import { Env } from "@/util/env"

export namespace ProviderCatalog {
  const log = Log.create({ service: "provider.catalog" })

  type ModelsDevRuntime = (typeof import("./models"))["ModelsDev"]
  let modelsDevRuntime: Promise<ModelsDevRuntime> | undefined

  function loadModelsDevRuntime() {
    if (!modelsDevRuntime) {
      modelsDevRuntime = import("./models").then((module) => module.ModelsDev)
    }
    return modelsDevRuntime
  }

  export const DEFAULT_REGISTRY_URL =
    "https://raw.githubusercontent.com/SII-Holos/synergy-provider-registry/main/catalog.v1.json"
  export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000
  export const DEFAULT_PUBLIC_KEY = "cUp5d09eZbq8Akcx4jZJSFFzQS2oZqI1m5JOhFy0mgk="
  export const RETRY_DELAY_MS = 60 * 1000
  export const MAX_SNAPSHOT_ENTRIES = 100

  export const Failure = z.enum(["timeout", "network", "rate_limited", "upstream", "invalid_response"])
  export type Failure = z.infer<typeof Failure>

  const ModelCatalogEntry = z.object({
    id: z.string(),
    rank: z.number().optional(),
    model: ModelsDev.Model.partial().optional(),
    inputImage: z.boolean().optional(),
    supportedImageMediaTypes: z.array(z.string()).optional(),
  })

  export const Snapshot = z.object({
    version: z.literal(1),
    providerID: z.string(),
    identityHash: z.string(),
    activeModels: z.array(ModelCatalogEntry),
    retainedModels: z.array(ModelCatalogEntry),
    lastVerifiedAt: z.number().optional(),
    lastAttemptAt: z.number(),
    failure: Failure.optional(),
  })
  export type Snapshot = z.infer<typeof Snapshot>

  const SnapshotStore = z.object({
    version: z.literal(1),
    snapshots: z.array(Snapshot),
  })

  export const ModelCatalogState = z
    .object({
      source: z.enum(["live", "cached", "bundled"]),
      refreshing: z.boolean(),
      modelCount: z.number(),
      lastVerifiedAt: z.number().optional(),
      failure: Failure.optional(),
    })
    .meta({ ref: "ProviderModelCatalogState" })
  export type ModelCatalogState = z.infer<typeof ModelCatalogState>

  export const Config = z
    .object({
      enabled: z.boolean().optional().default(true),
      registryUrl: z.string().url().optional().default(DEFAULT_REGISTRY_URL),
      publicKey: z.string().optional().default(DEFAULT_PUBLIC_KEY),
      cacheTtlMs: z.number().int().positive().optional().default(DEFAULT_CACHE_TTL_MS),
      offlineCache: z.boolean().optional().default(true),
    })
    .strict()
    .meta({ ref: "ProviderCatalogConfig" })
  export type Config = z.infer<typeof Config>

  const RemoteModel = ModelsDev.Model.partial().extend({
    id: z.string().optional(),
  })
  const RemoteProvider = ModelsDev.Provider.partial()
    .extend({
      id: z.string(),
      name: z.string(),
      modelsDevProviderID: z.string().optional(),
      recommendation: ProviderProfile.Recommendation.optional(),
      authStrategy: z.string().optional(),
      runtimeStrategy: z.string().optional(),
      usageStrategy: z.string().optional(),
      fallbackModels: z.array(z.string()).optional(),
      models: z.record(z.string(), RemoteModel).optional(),
    })
    .strict()
  const RemoteCatalog = z
    .object({
      version: z.literal(1),
      providers: z.record(z.string(), RemoteProvider),
    })
    .strict()
  type RemoteCatalog = z.infer<typeof RemoteCatalog>

  type LiveDiscoveryContext = {
    auth?: Auth.Info
    identityHash: string
  }

  type LiveDiscoveryTarget = {
    profile: ProviderProfile.Profile
    context: LiveDiscoveryContext
    baseURL?: string
    configured?: ConfiguredProvider
  }

  type ConfiguredProvider = {
    profile?: string
    modelsDevProviderID?: string
    name?: string
    api?: string
    npm?: string
    env?: string[]
    options?: Record<string, unknown>
    models?: Record<string, Record<string, any>>
    whitelist?: string[]
    blacklist?: string[]
  }

  type CacheEntry = {
    value: Record<string, ModelsDev.Provider>
    createdAt: number
    ttlMs: number
  }

  const inFlight = new Map<string, Promise<Record<string, ModelsDev.Provider>>>()
  const memoryCache = new Map<string, CacheEntry>()
  const refreshInFlight = new Map<string, Promise<ModelCatalogState>>()
  const catalogStates = new Map<string, ModelCatalogState>()
  const freshlyVerified = new Set<string>()
  const scheduledRefreshes = new Set<string>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let snapshots: Map<string, Snapshot> | undefined
  let writeQueue = Promise.resolve()
  let cacheGeneration = 0

  function snapshotKey(providerID: string, identityHash: string) {
    return `${providerID}:${identityHash}`
  }

  function catalogStateKey(providerID: string) {
    return `${ScopeContext.tryScope()?.id ?? "global"}:${providerID}`
  }

  function isSensitiveConfiguredKey(key: string) {
    const normalized = key.replace(/[-_.]/g, "").toLowerCase()
    return (
      normalized === "auth" ||
      normalized === "cookie" ||
      normalized === "setcookie" ||
      normalized === "key" ||
      normalized === "keys" ||
      normalized === "credential" ||
      normalized === "credentials" ||
      normalized.endsWith("apikey") ||
      normalized.endsWith("apitoken") ||
      normalized.endsWith("sessiontoken") ||
      normalized.endsWith("accesskey") ||
      normalized.endsWith("accesskeyid") ||
      normalized.endsWith("privatekey") ||
      normalized.endsWith("password") ||
      normalized.includes("secret") ||
      normalized === "token" ||
      normalized.endsWith("token") ||
      normalized.endsWith("credential") ||
      normalized.endsWith("credentials") ||
      normalized.endsWith("authorization")
    )
  }

  function publicConfiguredValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(publicConfiguredValue)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) =>
        isSensitiveConfiguredKey(key) ? [] : [[key, publicConfiguredValue(entry)] as const],
      ),
    )
  }

  function modelRulesIdentity(provider: ConfiguredProvider) {
    const rules = {
      whitelist: provider.whitelist,
      blacklist: provider.blacklist,
      models: publicConfiguredValue(provider.models),
    }
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(rules)).digest("hex")
  }

  function applyConfiguredModelRules(provider: ModelsDev.Provider, configured: ConfiguredProvider) {
    const result = structuredClone(provider)
    for (const [modelID, raw] of Object.entries(configured.models ?? {})) {
      const model = publicConfiguredValue(raw) as Record<string, any>
      const sourceID = typeof model.id === "string" ? model.id : modelID
      const source = result.models[sourceID] ?? result.models[modelID] ?? fallbackModel(result, sourceID)
      result.models[modelID] = {
        ...(mergeDeep(source, model) as ModelsDev.Model),
        id: modelID,
      }
    }
    for (const modelID of Object.keys(result.models)) {
      if (configured.whitelist && !configured.whitelist.includes(modelID)) delete result.models[modelID]
      if (configured.blacklist?.includes(modelID)) delete result.models[modelID]
    }
    return result
  }

  function normalizeDiscoveryEndpoint(baseURL: string | undefined) {
    const value = baseURL?.trim()
    if (!value) return ""
    try {
      const url = new URL(value)
      url.hash = ""
      url.pathname = url.pathname.replace(/\/+$/, "") || "/"
      return url.toString().replace(/\/$/, "")
    } catch {
      return value.replace(/\/+$/, "")
    }
  }

  async function hashIdentity(providerID: string, profileID: string, baseURL: string | undefined, identity: string) {
    const endpoint = normalizeDiscoveryEndpoint(baseURL)
    const bytes = new TextEncoder().encode(`${providerID}\u0000${profileID}\u0000${endpoint}\u0000${identity}`)
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return Buffer.from(digest).toString("hex")
  }

  async function readSnapshots() {
    if (snapshots) return snapshots
    const parsed = SnapshotStore.safeParse(
      await Bun.file(Global.Path.providerModelCatalogCache)
        .json()
        .catch(() => undefined),
    )
    snapshots = new Map(
      parsed.success
        ? parsed.data.snapshots.map((snapshot) => [snapshotKey(snapshot.providerID, snapshot.identityHash), snapshot])
        : [],
    )
    return snapshots
  }

  async function persistSnapshots(currentKey: string) {
    const store = await readSnapshots()
    const protectedKeys = new Set([currentKey])
    for (const profile of ProviderProfile.all()) {
      if (!profile.fetchModelCatalog && !profile.fetchModels) continue
      const context = await resolveLiveDiscoveryContext(profile, profile.id, profile.baseURL).catch(() => undefined)
      if (context?.auth) protectedKeys.add(snapshotKey(profile.id, context.identityHash))
    }
    if (store.size > MAX_SNAPSHOT_ENTRIES) {
      const removable = [...store.entries()]
        .filter(([key]) => !protectedKeys.has(key))
        .sort(([, left], [, right]) => left.lastAttemptAt - right.lastAttemptAt)
      while (store.size > MAX_SNAPSHOT_ENTRIES) {
        const entry = removable.shift()
        if (!entry) break
        store.delete(entry[0])
        freshlyVerified.delete(entry[0])
      }
    }
    const value = SnapshotStore.parse({ version: 1, snapshots: [...store.values()] })
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(Global.Path.cache, { recursive: true })
        const temporary = `${Global.Path.providerModelCatalogCache}.${process.pid}.${crypto.randomUUID()}.tmp`
        await Bun.write(temporary, JSON.stringify(value, null, 2))
        await fs.rename(temporary, Global.Path.providerModelCatalogCache)
      })
    await writeQueue
  }

  function classifyFailure(error: unknown): Failure {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      return "timeout"
    if (error && typeof error === "object") {
      const record = error as Record<string, unknown>
      const status = typeof record.status === "number" ? record.status : undefined
      const code = typeof record.code === "string" ? record.code : undefined
      if (status === 429 || code === "rate_limited" || code === "rate_limit_exceeded") return "rate_limited"
      if (error instanceof TypeError) return "network"
    }
    return "upstream"
  }

  export function retryDelay(input: { failure: Failure; retryAfterMs?: number }) {
    if (input.failure === "rate_limited" && input.retryAfterMs !== undefined) return Math.max(0, input.retryAfterMs)
    return RETRY_DELAY_MS
  }

  function fallbackModel(provider: ModelsDev.Provider, modelID: string): ModelsDev.Model {
    return {
      id: modelID,
      name: modelID,
      family: modelID.split(/[-/:]/)[0] || modelID,
      release_date: "2026-06-25",
      attachment: false,
      reasoning: modelID.includes("gpt-5") || modelID.includes("claude") || modelID.includes("qwen"),
      temperature: false,
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: { context: 128000, input: 96000, output: 32000 },
      modalities: {
        input: ["text"],
        output: ["text"],
      },
      options: {},
      provider: {
        npm: provider.npm ?? "@ai-sdk/openai-compatible",
      },
    }
  }

  function modelFromSource(input: {
    modelID: string
    provider: ModelsDev.Provider
    sourceModel?: ModelsDev.Model
    profile?: ProviderProfile.Profile
    npm: string
    patch?: Partial<ModelsDev.Model>
    inputImage?: boolean
    supportedImageMediaTypes?: string[]
  }): ModelsDev.Model {
    const base = input.sourceModel
      ? {
          ...input.sourceModel,
          id: input.modelID,
          options: { ...input.sourceModel.options },
          headers: { ...input.sourceModel.headers },
          provider: {
            ...(input.sourceModel.provider ?? {}),
            npm: input.profile?.aiSdkPackage ?? input.sourceModel.provider?.npm ?? input.provider.npm ?? input.npm,
          },
        }
      : fallbackModel(input.provider, input.modelID)
    const model = input.patch ? (mergeDeep(base, input.patch) as ModelsDev.Model) : base
    if (input.inputImage !== undefined) {
      const modalities = model.modalities ?? { input: ["text"], output: ["text"] }
      const hasImage = modalities.input.includes("image")
      model.modalities = {
        ...modalities,
        input: input.inputImage
          ? hasImage
            ? modalities.input
            : [...modalities.input, "image"]
          : modalities.input.filter((modality) => modality !== "image"),
      }
    }
    if (input.supportedImageMediaTypes !== undefined) {
      model.supported_image_media_types = normalizeImageMediaTypes(input.supportedImageMediaTypes) ?? []
    }
    model.id = input.modelID
    model.provider = {
      ...(model.provider ?? {}),
      npm: input.profile?.aiSdkPackage ?? model.provider?.npm ?? input.provider.npm ?? input.npm,
    }
    return model
  }

  function withBuiltinSourceSurfaces(
    modelsDev: Record<string, ModelsDev.Provider>,
  ): Record<string, ModelsDev.Provider> {
    return {
      ...modelsDev,
      [CodexProvider.PROVIDER_ID]: CodexProvider.modelsDevProvider(
        CodexProvider.DEFAULT_MODEL_IDS,
        modelsDev.openai?.models,
      ),
    }
  }

  function profileProvider(
    profile: ProviderProfile.Profile,
    modelsDev: Record<string, ModelsDev.Provider>,
  ): ModelsDev.Provider {
    const sourceID = profile.modelsDevProviderID ?? profile.id
    const source = modelsDev[sourceID]
    const metadataSource = profile.sourceModelProviderID ? modelsDev[profile.sourceModelProviderID] : undefined
    const sourceModelIDs = Object.keys(source?.models ?? {})
    const mappedProvider = sourceID !== profile.id
    const modelIDs =
      mappedProvider && profile.fallbackModels && profile.fallbackModels.length > 0
        ? profile.fallbackModels
        : sourceModelIDs.length > 0
          ? sourceModelIDs
          : (profile.fallbackModels ?? [])
    const inheritsSourceEnv = profile.authKind === undefined || profile.authKind === "api_key"
    const provider: ModelsDev.Provider = {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      signupUrl: profile.signupUrl,
      recommendation: profile.recommendation,
      env: profile.env ?? (inheritsSourceEnv ? (source?.env ?? []) : []),
      api: profile.baseURL ?? source?.api,
      npm: profile.aiSdkPackage ?? source?.npm,
      models: {},
    }
    const npm = profile.aiSdkPackage ?? source?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
    for (const modelID of modelIDs) {
      const sourceModel = source?.models?.[modelID] ?? metadataSource?.models?.[modelID]
      provider.models[modelID] = modelFromSource({
        modelID,
        provider,
        sourceModel,
        profile,
        npm,
      })
    }
    return provider
  }

  function mergeProvider(
    base: ModelsDev.Provider | undefined,
    override: Partial<ModelsDev.Provider>,
  ): ModelsDev.Provider {
    const merged = mergeDeep(
      base ?? {
        id: override.id!,
        name: override.name ?? override.id!,
        env: [],
        models: {},
      },
      override,
    ) as ModelsDev.Provider
    merged.id = override.id ?? merged.id
    merged.name = override.name ?? merged.name ?? merged.id
    merged.env ??= []
    merged.models ??= {}
    return merged
  }

  type ProviderMetadataSource = {
    id: string
    name: string
    description?: string
    signupUrl?: string
    recommendation?: ProviderProfile.Recommendation
  }

  export function providerMetadata(provider: ProviderMetadataSource, profileID?: string): ProviderProfile.Metadata {
    const profile = ProviderProfile.resolve(provider.id, profileID)
    return {
      id: provider.id,
      name: profile?.name ?? provider.name,
      ...(profile?.displayName ? { displayName: profile.displayName } : {}),
      ...(profile?.description || provider.description
        ? { description: profile?.description ?? provider.description }
        : {}),
      ...(profile?.signupUrl || provider.signupUrl ? { signupUrl: profile?.signupUrl ?? provider.signupUrl } : {}),
      ...(profile?.recommendation || provider.recommendation
        ? { recommendation: profile?.recommendation ?? (provider.recommendation as ProviderProfile.Recommendation) }
        : {}),
    }
  }

  export async function metadata(input?: {
    config?: Partial<Config> | Record<string, unknown>
  }): Promise<Record<string, ProviderProfile.Metadata>> {
    const providers = await resolve(input)
    return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, providerMetadata(provider)]))
  }

  async function verifySignature(text: string, signature: string, publicKey: string): Promise<boolean> {
    if (!publicKey.trim()) return false
    try {
      const key = await crypto.subtle.importKey("raw", Buffer.from(publicKey, "base64"), { name: "Ed25519" }, false, [
        "verify",
      ])
      return crypto.subtle.verify("Ed25519", key, Buffer.from(signature, "base64"), new TextEncoder().encode(text))
    } catch (error) {
      log.warn("failed to verify provider catalog signature", { error })
      return false
    }
  }

  async function readCachedRemote(
    config: Config,
    options?: { allowStale?: boolean },
  ): Promise<RemoteCatalog | undefined> {
    if (!config.offlineCache) return undefined
    const file = Bun.file(Global.Path.providerCatalogCache)
    const stat = await file.stat().catch(() => undefined)
    if (!stat) return undefined
    if (!options?.allowStale && Date.now() - stat.mtimeMs > config.cacheTtlMs) return undefined
    const parsed = RemoteCatalog.safeParse(await file.json().catch(() => undefined))
    return parsed.success ? parsed.data : undefined
  }

  const remoteRefreshInFlight = new Map<string, Promise<void>>()
  const lastRemoteCatalogs = new Map<string, { catalog: RemoteCatalog; fetchedAt: number }>()
  const remoteRefreshCooldownUntil = new Map<string, number>()

  function remoteRefreshKey(config: Config) {
    return `${config.registryUrl}|${config.publicKey}`
  }

  async function refreshRemote(config: Config): Promise<RemoteCatalog | undefined> {
    const [catalogResponse, signatureResponse] = await Promise.all([
      fetch(config.registryUrl, {
        headers: { "User-Agent": Installation.USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
      fetch(`${config.registryUrl}.sig`, {
        headers: { "User-Agent": Installation.USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
    ])
    if (!catalogResponse?.ok || !signatureResponse?.ok) return undefined
    const text = await catalogResponse.text()
    const signature = (await signatureResponse.text()).trim()
    if (!(await verifySignature(text, signature, config.publicKey))) return undefined
    const parsed = RemoteCatalog.safeParse(JSON.parse(text))
    if (!parsed.success) return undefined
    await Bun.write(Global.Path.providerCatalogCache, JSON.stringify(parsed.data, null, 2)).catch(() => {})
    lastRemoteCatalogs.set(remoteRefreshKey(config), { catalog: parsed.data, fetchedAt: Date.now() })
    // Invalidate resolved projections so a resolve that started before the
    // fresh registry data landed cannot cache a stale snapshot.
    invalidateModelsDevProjection()
    return parsed.data
  }

  function scheduleRemoteRefresh(config: Config) {
    const key = remoteRefreshKey(config)
    if (remoteRefreshInFlight.has(key)) return
    if ((remoteRefreshCooldownUntil.get(key) ?? 0) > Date.now()) return
    remoteRefreshInFlight.set(
      key,
      refreshRemote(config)
        .then((fresh) => {
          if (fresh) remoteRefreshCooldownUntil.delete(key)
          else remoteRefreshCooldownUntil.set(key, Date.now() + RETRY_DELAY_MS)
        })
        .catch((error) => {
          log.warn("failed to refresh provider registry catalog", { error })
          remoteRefreshCooldownUntil.set(key, Date.now() + RETRY_DELAY_MS)
        })
        .finally(() => {
          remoteRefreshInFlight.delete(key)
        }),
    )
  }

  async function fetchRemote(config: Config, options?: { forceRefresh?: boolean }): Promise<RemoteCatalog | undefined> {
    if (!config.enabled) return readCachedRemote(config)
    if (process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH === "true") return readCachedRemote(config)
    if (!config.publicKey.trim()) return readCachedRemote(config)
    // Serve the last known registry catalog immediately (stale included) and
    // refresh in the background so a slow or unreachable registry can never
    // stall startup or health checks. Only an explicit refresh waits on the
    // network; a cold first run serves bundled data and picks the registry up
    // on the next resolution.
    if (options?.forceRefresh) {
      const fresh = await refreshRemote(config).catch((error) => {
        log.warn("failed to refresh provider registry catalog", { error })
        return undefined
      })
      return fresh ?? readCachedRemote(config, { allowStale: true })
    }
    const cached = await readCachedRemote(config, { allowStale: true })
    const key = remoteRefreshKey(config)
    const lastKnown = lastRemoteCatalogs.get(key)
    const remote = cached ?? lastKnown?.catalog
    const lastFetchAt = lastKnown?.fetchedAt ?? (await cachedMtime(config))
    if (!remote || Date.now() - lastFetchAt > config.cacheTtlMs) scheduleRemoteRefresh(config)
    return remote
  }

  async function cachedMtime(config: Config): Promise<number> {
    const stat = await Bun.file(Global.Path.providerCatalogCache)
      .stat()
      .catch(() => undefined)
    return stat?.mtimeMs ?? 0
  }

  function applySnapshotEntries(
    provider: ModelsDev.Provider,
    profile: ProviderProfile.Profile,
    modelsDev: Record<string, ModelsDev.Provider>,
    snapshot: Snapshot,
  ): ModelsDev.Provider {
    const source = modelsDev[profile.modelsDevProviderID ?? profile.id]
    const metadataSource = profile.sourceModelProviderID ? modelsDev[profile.sourceModelProviderID] : undefined
    const npm = profile.aiSdkPackage ?? source?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
    const next: ModelsDev.Provider = { ...provider, models: {} }
    for (const [catalogState, entries] of [
      ["active", snapshot.activeModels],
      ["retained", snapshot.retainedModels],
    ] as const) {
      for (const entry of entries) {
        const modelID = entry.id
        const sourceModel = source?.models?.[modelID] ?? provider.models[modelID] ?? metadataSource?.models?.[modelID]
        next.models[modelID] = modelFromSource({
          modelID,
          provider,
          sourceModel,
          profile,
          npm,
          patch: entry.model,
          inputImage: entry.inputImage,
          supportedImageMediaTypes: entry.supportedImageMediaTypes,
        })
        next.models[modelID].catalog_state = catalogState
      }
    }
    return next
  }

  function defaultCredentialIdentity(credentialID: string, auth: Auth.Info) {
    let credential: Record<string, unknown>
    switch (auth.type) {
      case "api":
        credential = { type: auth.type, key: auth.key }
        break
      case "oauth":
        credential = { type: auth.type, refresh: auth.refresh, enterpriseUrl: auth.enterpriseUrl }
        break
      case "wellknown":
        credential = { type: auth.type, key: auth.key, token: auth.token }
        break
      case "holos":
        credential = { type: auth.type, agentId: auth.agentId, agentSecret: auth.agentSecret }
        break
      default: {
        const unsupported: never = auth
        throw new Error(`Unsupported auth type: ${String(unsupported)}`)
      }
    }
    return JSON.stringify({ credentialID, credential })
  }

  async function resolveLiveDiscoveryContext(
    profile: ProviderProfile.Profile,
    providerID = profile.id,
    baseURL = profile.baseURL,
    configured?: ConfiguredProvider,
  ): Promise<LiveDiscoveryContext> {
    const selected = await Auth.select(providerID)
    const environmentValues = ScopeContext.tryScope() ? Env.all() : process.env
    const environmentNames = configured?.env ?? (providerID === profile.id ? (profile.env ?? []) : [])
    const environment = environmentNames
      .map((name) => ({ name, value: environmentValues[name]?.trim() }))
      .find((entry) => entry.value)
    const environmentAuth = environment?.value
      ? ({ type: "api", key: environment.value } satisfies Auth.Info)
      : undefined
    const inlineKey =
      typeof configured?.options?.apiKey === "string" && configured.options.apiKey
        ? configured.options.apiKey
        : undefined
    const inlineAuth = inlineKey ? ({ type: "api", key: inlineKey } satisfies Auth.Info) : undefined
    const resolvedCredential = inlineAuth
      ? {
          auth: inlineAuth,
          credentialID: "config:options.apiKey",
          authUpdatedAt: undefined,
        }
      : selected
        ? {
            auth: selected.auth,
            credentialID: selected.credentialID,
            authUpdatedAt: selected.poolEntry?.updatedAt ?? selected.entry.updatedAt,
          }
        : environmentAuth
          ? {
              auth: environmentAuth,
              credentialID: `env:${environment?.name}`,
              authUpdatedAt: undefined,
            }
          : undefined
    const auth = resolvedCredential?.auth
    const credentialID = resolvedCredential?.credentialID
    const authUpdatedAt = resolvedCredential?.authUpdatedAt
    const customIdentity = await profile.modelCatalogIdentity?.({
      providerID,
      auth,
      credentialID,
      authUpdatedAt,
    })
    const identity =
      customIdentity ??
      (auth && credentialID
        ? defaultCredentialIdentity(credentialID, auth)
        : profile.authKind === "none"
          ? "anonymous"
          : "unauthenticated")
    return { auth, identityHash: await hashIdentity(providerID, profile.id, baseURL, identity) }
  }

  function configuredProviders(config: unknown): Record<string, ConfiguredProvider> {
    return config && typeof config === "object" && "provider" in config
      ? ((config.provider as Record<string, ConfiguredProvider> | undefined) ?? {})
      : {}
  }

  function configuredProfiles(config: unknown) {
    return Object.entries(configuredProviders(config)).flatMap(([providerID, provider]) => {
      if (!provider?.profile) return []
      const profile = ProviderProfile.get(provider.profile)
      if (!profile) {
        log.warn("configured provider profile not found", { providerID, profileID: provider.profile })
        return []
      }
      return [[providerID, profile] as const]
    })
  }

  async function resolveLiveDiscoveryContexts(includeLive: boolean | undefined, config: unknown) {
    const targets = new Map<string, LiveDiscoveryTarget>()
    if (!includeLive) return targets

    registerBuiltinProviderProfiles()
    const profiles = new Map(ProviderProfile.all().map((profile) => [profile.id, profile]))
    for (const [providerID, profile] of configuredProfiles(config)) profiles.set(providerID, profile)
    for (const [providerID, profile] of profiles) {
      if (!profile.fetchModelCatalog && !profile.fetchModels) continue
      const configured = configuredProviders(config)[providerID]
      const baseURL =
        (typeof configured?.options?.baseURL === "string" ? configured.options.baseURL : undefined) ??
        configured?.api ??
        profile.baseURL
      targets.set(providerID, {
        profile,
        context: await resolveLiveDiscoveryContext(profile, providerID, baseURL, configured),
        baseURL,
        configured,
      })
    }
    return targets
  }

  async function applyCachedDiscovery(
    provider: ModelsDev.Provider,
    profile: ProviderProfile.Profile,
    modelsDev: Record<string, ModelsDev.Provider>,
    context: LiveDiscoveryContext | undefined,
    providerID = profile.id,
  ): Promise<ModelsDev.Provider> {
    if (!profile.fetchModelCatalog && !profile.fetchModels) return provider
    const auth = context?.auth
    if (!auth && profile.authKind !== "none") {
      catalogStates.delete(catalogStateKey(providerID))
      return provider
    }
    const key = context ? snapshotKey(providerID, context.identityHash) : undefined
    const snapshot = key ? (await readSnapshots()).get(key) : undefined
    // A failed refresh that never verified successfully has no authoritative
    // model list; applying its empty snapshot would wipe the bundled fallback
    // models and make the provider look unconfigured, so keep the bundled set.
    const neverVerified = snapshot ? snapshot.failure !== undefined && snapshot.lastVerifiedAt === undefined : false
    const modelCount = neverVerified
      ? Object.keys(provider.models).length
      : (snapshot?.activeModels.length ?? Object.keys(provider.models).length)
    catalogStates.set(catalogStateKey(providerID), {
      source:
        snapshot && key && freshlyVerified.has(key)
          ? "live"
          : snapshot
            ? neverVerified
              ? "bundled"
              : "cached"
            : "bundled",
      refreshing: key ? refreshInFlight.has(key) || scheduledRefreshes.has(key) : false,
      modelCount,
      lastVerifiedAt: snapshot?.lastVerifiedAt,
      failure: snapshot?.failure,
    })
    if (!snapshot || neverVerified) return provider
    return applySnapshotEntries(provider, profile, modelsDev, snapshot)
  }

  function retryAfterMs(error: unknown) {
    if (!error || typeof error !== "object") return undefined
    const record = error as Record<string, unknown>
    if (typeof record.retryAfterMs === "number") return record.retryAfterMs
    if (typeof record.retryAfterSeconds === "number") return record.retryAfterSeconds * 1000
    return undefined
  }

  function scheduleRetry(
    providerID: string,
    profileID: string,
    baseURL: string | undefined,
    configured: ConfiguredProvider | undefined,
    failure: Failure,
    error?: unknown,
  ) {
    const current = retryTimers.get(providerID)
    if (current) clearTimeout(current)
    const timer = setTimeout(
      () => {
        retryTimers.delete(providerID)
        void refreshAndReload(providerID, profileID, baseURL, configured)
      },
      retryDelay({ failure, retryAfterMs: retryAfterMs(error) }),
    )
    timer.unref()
    retryTimers.set(providerID, timer)
  }

  function mergeRefresh(
    previous: Snapshot | undefined,
    entries: ProviderProfile.ModelCatalogEntry[],
    input: {
      providerID: string
      identityHash: string
      now: number
    },
  ): Snapshot {
    const activeIDs = new Set(entries.map((entry) => entry.id))
    const retained = new Map(
      [...(previous?.retainedModels ?? []), ...(previous?.activeModels ?? [])]
        .filter((entry) => !activeIDs.has(entry.id))
        .map((entry) => [entry.id, entry]),
    )
    return {
      version: 1,
      providerID: input.providerID,
      identityHash: input.identityHash,
      activeModels: entries.map((entry) => ({ ...entry })),
      retainedModels: [...retained.values()],
      lastVerifiedAt: input.now,
      lastAttemptAt: input.now,
    }
  }

  export async function refresh(
    providerID: string,
    profileID?: string,
    baseURL?: string,
    configuredInput?: ConfiguredProvider,
  ): Promise<ModelCatalogState> {
    registerBuiltinProviderProfiles()
    await registerPluginProfiles()
    let profile = ProviderProfile.resolve(providerID, profileID)
    let configured = configuredInput
    if (ScopeContext.tryScope() && (!configured || profileID === undefined || baseURL === undefined)) {
      const { Config } = await import("@/config/config")
      const config = await Config.current()
      configured ??= config.provider?.[providerID]
      if (profileID === undefined && configured?.profile) profile = ProviderProfile.get(configured.profile)
      else if (!profile) profile = ProviderProfile.get(configured?.profile ?? "")
    }
    if (!profile?.fetchModelCatalog && !profile?.fetchModels) {
      return { source: "bundled", refreshing: false, modelCount: 0 }
    }
    const resolvedBaseURL =
      baseURL ??
      (typeof configured?.options?.baseURL === "string" ? configured.options.baseURL : undefined) ??
      configured?.api ??
      profile.baseURL
    const context = await resolveLiveDiscoveryContext(profile, providerID, resolvedBaseURL, configured)
    const key = snapshotKey(providerID, context.identityHash)
    const pending = refreshInFlight.get(key)
    if (pending) return pending

    let request: Promise<ModelCatalogState>
    request = (async () => {
      const store = await readSnapshots()
      const previous = store.get(key)
      const now = Date.now()
      catalogStates.set(catalogStateKey(providerID), {
        source: previous ? (freshlyVerified.has(key) ? "live" : "cached") : "bundled",
        refreshing: true,
        modelCount: previous?.activeModels.length ?? 0,
        lastVerifiedAt: previous?.lastVerifiedAt,
        failure: previous?.failure,
      })

      let entries: ProviderProfile.ModelCatalogEntry[]
      try {
        entries = profile.fetchModelCatalog
          ? await profile.fetchModelCatalog({ providerID, auth: context.auth, fetch, baseURL: resolvedBaseURL })
          : (await profile.fetchModels!({ providerID, auth: context.auth, fetch, baseURL: resolvedBaseURL })).map(
              (id) => ({ id }),
            )
        if (entries.length === 0)
          throw Object.assign(new Error("provider returned an empty model catalog"), {
            catalogFailure: "invalid_response",
          })
      } catch (error) {
        const failure =
          error && typeof error === "object" && (error as Record<string, unknown>).catalogFailure === "invalid_response"
            ? ("invalid_response" as const)
            : classifyFailure(error)
        const failed: Snapshot = {
          version: 1,
          providerID,
          identityHash: context.identityHash,
          activeModels: previous?.activeModels ?? [],
          retainedModels: previous?.retainedModels ?? [],
          lastVerifiedAt: previous?.lastVerifiedAt,
          lastAttemptAt: now,
          failure,
        }
        store.set(key, failed)
        await persistSnapshots(key)
        memoryCache.clear()
        const state: ModelCatalogState = {
          source: previous ? (freshlyVerified.has(key) ? "live" : "cached") : "bundled",
          refreshing: false,
          modelCount: failed.activeModels.length,
          lastVerifiedAt: failed.lastVerifiedAt,
          failure,
        }
        catalogStates.set(catalogStateKey(providerID), state)
        scheduleRetry(providerID, profile.id, resolvedBaseURL, configured, failure, error)
        log.warn("failed to refresh provider model catalog", { providerID, profileID: profile.id, failure, error })
        return state
      }

      const next = mergeRefresh(previous, entries, { providerID, identityHash: context.identityHash, now })
      store.set(key, next)
      await persistSnapshots(key)
      memoryCache.clear()
      freshlyVerified.add(key)
      const retry = retryTimers.get(providerID)
      if (retry) clearTimeout(retry)
      retryTimers.delete(providerID)
      const state: ModelCatalogState = {
        source: "live",
        refreshing: false,
        modelCount: next.activeModels.length,
        lastVerifiedAt: next.lastVerifiedAt,
      }
      catalogStates.set(catalogStateKey(providerID), state)
      return state
    })().finally(() => {
      if (refreshInFlight.get(key) === request) refreshInFlight.delete(key)
      scheduledRefreshes.delete(key)
    })
    refreshInFlight.set(key, request)
    return request
  }

  async function refreshAndReload(
    providerID: string,
    profileID?: string,
    baseURL?: string,
    configured?: ConfiguredProvider,
  ) {
    try {
      await refresh(providerID, profileID, baseURL, configured)
      const { RuntimeReload } = await import("@/runtime/reload")
      await RuntimeReload.reload({ targets: ["provider"], reason: "provider model catalog refreshed" })
    } catch (error) {
      log.warn("failed to apply provider model catalog refresh", { providerID, error })
    }
  }

  function scheduleRefresh(
    providerID: string,
    profile: ProviderProfile.Profile,
    context: LiveDiscoveryContext,
    baseURL: string | undefined,
    configured: ConfiguredProvider | undefined,
    snapshot: Snapshot | undefined,
  ) {
    if (!context.auth && profile.authKind !== "none") return
    const now = Date.now()
    const verifiedRecently = snapshot?.lastVerifiedAt && now - snapshot.lastVerifiedAt < DEFAULT_CACHE_TTL_MS
    const failedRecently = snapshot?.failure && now - snapshot.lastAttemptAt < RETRY_DELAY_MS
    if (verifiedRecently || failedRecently) return
    const key = snapshotKey(providerID, context.identityHash)
    if (refreshInFlight.has(key) || scheduledRefreshes.has(key)) return
    scheduledRefreshes.add(key)
    queueMicrotask(() => {
      void refreshAndReload(providerID, profile.id, baseURL, configured).finally(() => scheduledRefreshes.delete(key))
    })
  }

  export async function resolve(input?: {
    config?: unknown
    includeLive?: boolean
    forceRefresh?: boolean
  }): Promise<Record<string, ModelsDev.Provider>> {
    registerBuiltinProviderProfiles()
    await registerPluginProfiles()
    const liveContexts = await resolveLiveDiscoveryContexts(input?.includeLive, input?.config)
    const key = cacheKey(input, liveContexts)
    const cached = memoryCache.get(key)
    if (!input?.forceRefresh && cached && Date.now() - cached.createdAt < cached.ttlMs) {
      return cached.value
    }
    const pending = inFlight.get(key)
    if (!input?.forceRefresh && pending) return pending
    const generation = cacheGeneration
    let request: Promise<Record<string, ModelsDev.Provider>>
    request = doResolve(input, liveContexts, key, generation).finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key)
    })
    inFlight.set(key, request)
    return request
  }

  function cacheKey(
    input: { config?: unknown; includeLive?: boolean } | undefined,
    liveContexts: Map<string, LiveDiscoveryTarget>,
  ) {
    const providerCatalog = (input?.config as { providerCatalog?: unknown } | undefined)?.providerCatalog ?? {}
    const connections = Object.fromEntries(
      Object.entries(configuredProviders(input?.config)).flatMap(([providerID, provider]) =>
        provider.profile || provider.modelsDevProviderID
          ? [
              [
                providerID,
                {
                  profile: provider.profile,
                  modelsDevProviderID: provider.modelsDevProviderID,
                  name: provider.name,
                  api: provider.api,
                  npm: provider.npm,
                  env: provider.env,
                  modelRules: modelRulesIdentity(provider),
                },
              ],
            ]
          : [],
      ),
    )
    const liveIdentities = Object.fromEntries(
      [...liveContexts.entries()].map(([providerID, target]) => [providerID, target.context.identityHash]),
    )
    return JSON.stringify({ includeLive: input?.includeLive === true, providerCatalog, connections, liveIdentities })
  }

  async function doResolve(
    input: { config?: unknown; includeLive?: boolean; forceRefresh?: boolean } | undefined,
    liveContexts: Map<string, LiveDiscoveryTarget>,
    key: string,
    generation: number,
  ): Promise<Record<string, ModelsDev.Provider>> {
    const config = Config.parse((input?.config as any)?.providerCatalog ?? {})
    const runtimeModelsDev = await loadModelsDevRuntime()
    const modelsDev = withBuiltinSourceSurfaces(await runtimeModelsDev.get())
    const result: Record<string, ModelsDev.Provider> = { ...modelsDev }

    for (const [providerID, provider] of Object.entries(bundledSnapshot(modelsDev))) {
      result[providerID] = mergeProvider(result[providerID], provider)
    }

    const remote = await fetchRemote(config, { forceRefresh: input?.forceRefresh === true })
    if (remote) {
      for (const [providerID, provider] of Object.entries(remote.providers)) {
        const source = provider.modelsDevProviderID ? modelsDev[provider.modelsDevProviderID] : undefined
        const base = result[providerID] ?? (source ? { ...source, id: providerID, name: provider.name } : undefined)
        const merged = mergeProvider(base, {
          ...provider,
          id: providerID,
        } as Partial<ModelsDev.Provider>)
        for (const modelID of provider.fallbackModels ?? []) {
          const sourceModel = source?.models?.[modelID]
          if (sourceModel && !provider.models?.[modelID]) {
            merged.models[modelID] = {
              ...sourceModel,
              id: modelID,
              provider: {
                ...(sourceModel.provider ?? {}),
                npm: merged.npm ?? sourceModel.provider?.npm ?? source?.npm ?? "@ai-sdk/openai-compatible",
              },
            }
            continue
          }
          if (merged.models[modelID]) continue
          merged.models[modelID] = sourceModel
            ? {
                ...sourceModel,
                id: modelID,
                provider: {
                  ...(sourceModel.provider ?? {}),
                  npm: merged.npm ?? sourceModel.provider?.npm ?? source?.npm ?? "@ai-sdk/openai-compatible",
                },
              }
            : fallbackModel(merged, modelID)
        }
        result[providerID] = merged
      }
    }

    for (const [providerID, provider] of Object.entries(configuredProviders(input?.config))) {
      const profile = provider.profile ? ProviderProfile.get(provider.profile) : undefined
      if (provider.profile && !profile) continue
      const sourceID = provider.modelsDevProviderID ?? profile?.modelsDevProviderID ?? profile?.id
      if (!sourceID) continue
      const source = result[sourceID]
      if (!source) {
        log.warn("configured provider catalog source not found", {
          providerID,
          profileID: profile?.id,
          modelsDevProviderID: sourceID,
        })
        continue
      }
      result[providerID] = applyConfiguredModelRules(
        mergeProvider(structuredClone(source), {
          id: providerID,
          name: provider.name ?? source.name,
          api: provider.api ?? source.api,
          npm: provider.npm ?? source.npm,
          env: provider.env ?? [],
        }),
        provider,
      )
    }

    if (input?.includeLive) {
      for (const [providerID, target] of liveContexts) {
        const provider = result[providerID]
        if (!provider) continue
        const discovered = await applyCachedDiscovery(provider, target.profile, modelsDev, target.context, providerID)
        const projected = target.configured ? applyConfiguredModelRules(discovered, target.configured) : discovered
        result[providerID] = projected
        const state = catalogStates.get(catalogStateKey(providerID))
        if (state && target.configured) {
          catalogStates.set(catalogStateKey(providerID), {
            ...state,
            modelCount: Object.values(projected.models).filter((model) => model.catalog_state !== "retained").length,
          })
        }
        if (target.profile.fetchModelCatalog || target.profile.fetchModels) {
          const snapshot = (await readSnapshots()).get(snapshotKey(providerID, target.context.identityHash))
          scheduleRefresh(providerID, target.profile, target.context, target.baseURL, target.configured, snapshot)
        }
      }
    }

    if (generation === cacheGeneration) {
      memoryCache.set(key, {
        value: result,
        createdAt: Date.now(),
        ttlMs: DEFAULT_CACHE_TTL_MS,
      })
    }
    return result
  }

  async function registerPluginProfiles() {
    const entries = (await ProviderPluginAuth.get()?.authProviderProfiles()) ?? []
    ProviderProfile.clearPluginProfiles()
    for (const profile of entries) {
      ProviderProfile.register({
        id: profile.id,
        name: profile.name,
        origin: "plugin",
        aliases: profile.aliases,
        description: profile.description,
        signupUrl: profile.signupUrl,
        recommendation: profile.recommendation as ProviderProfile.Profile["recommendation"],
        env: profile.env,
        baseURL: profile.baseURL,
        modelsURL: profile.modelsURL,
        authKind: profile.authKind as ProviderProfile.Profile["authKind"],
        fallbackModels: profile.fallbackModels,
      })
    }
  }

  export function bundledSnapshot(modelsDev: Record<string, ModelsDev.Provider>): Record<string, ModelsDev.Provider> {
    registerBuiltinProviderProfiles()
    const sourceModelsDev = withBuiltinSourceSurfaces(modelsDev)
    const result: Record<string, ModelsDev.Provider> = {}
    for (const profile of ProviderProfile.all()) {
      result[profile.id] = profileProvider(profile, sourceModelsDev)
    }
    return result
  }

  function invalidateModelsDevProjection() {
    cacheGeneration++
    memoryCache.clear()
    inFlight.clear()
  }

  export function reset() {
    cacheGeneration++
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
    refreshInFlight.clear()
    scheduledRefreshes.clear()
    memoryCache.clear()
    inFlight.clear()
    catalogStates.clear()
    freshlyVerified.clear()
    snapshots = undefined
    remoteRefreshInFlight.clear()
    remoteRefreshCooldownUntil.clear()
    lastRemoteCatalogs.clear()
  }

  void loadModelsDevRuntime()
    .then((modelsDevRuntime) =>
      modelsDevRuntime.onRefresh(async () => {
        invalidateModelsDevProjection()
        const { RuntimeReload } = await import("@/runtime/reload")
        await RuntimeReload.reloadGlobal({ targets: ["provider"], reason: "models.dev catalog refreshed" })
      }),
    )
    .catch((error) => {
      log.warn("failed to register models.dev refresh listener", { error })
    })

  export function modelCatalogState(providerID: string) {
    return catalogStates.get(catalogStateKey(providerID))
  }
}
