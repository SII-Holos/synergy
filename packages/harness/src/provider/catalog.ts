import { RuntimeContext } from "../lifecycle/context"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
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
import { Env } from "../util/env"

export namespace ProviderCatalog {
  const log = Log.create({ service: "provider.catalog" })

  type ModelsCatalogRuntime = (typeof import("./models"))["ModelsCatalog"]
  const runtimeState = RuntimeContext.state(() => ({
    shutdown: new AbortController(),
    jobs: new Set<Promise<unknown>>(),
    modelsCatalogRuntime: undefined as Promise<ModelsCatalogRuntime> | undefined,
    inFlight: new Map<string, Promise<Record<string, ModelsDev.Provider>>>(),
    memoryCache: new Map<string, CacheEntry>(),
    refreshInFlight: new Map<string, Promise<ModelCatalogState>>(),
    catalogStates: new Map<string, ModelCatalogState>(),
    freshlyVerified: new Set<string>(),
    scheduledRefreshes: new Set<string>(),
    retryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    snapshots: undefined as Map<string, Snapshot> | undefined,
    writeQueue: Promise.resolve(),
    cacheGeneration: 0,
  }))

  function loadModelsCatalogRuntime() {
    const instanceState = runtimeState()

    if (!instanceState.modelsCatalogRuntime) {
      instanceState.modelsCatalogRuntime = import("./models").then((module) => module.ModelsCatalog)
    }
    return instanceState.modelsCatalogRuntime
  }

  export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000
  export const MAX_SNAPSHOT_ENTRIES = 100
  const RETRY_DELAY_MS = 60 * 1000

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
    const instanceState = runtimeState()

    if (instanceState.snapshots) return instanceState.snapshots
    const parsed = SnapshotStore.safeParse(
      await Bun.file(Global.Path.providerModelCatalogCache)
        .json()
        .catch(() => undefined),
    )
    instanceState.snapshots = new Map(
      parsed.success
        ? parsed.data.snapshots.map((snapshot) => [snapshotKey(snapshot.providerID, snapshot.identityHash), snapshot])
        : [],
    )
    return instanceState.snapshots
  }

  async function persistSnapshots(currentKey: string) {
    const instanceState = runtimeState()

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
        instanceState.freshlyVerified.delete(entry[0])
      }
    }
    const value = SnapshotStore.parse({ version: 1, snapshots: [...store.values()] })
    instanceState.writeQueue = instanceState.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(Global.Path.cache, { recursive: true })
        const temporary = `${Global.Path.providerModelCatalogCache}.${process.pid}.${crypto.randomUUID()}.tmp`
        await Bun.write(temporary, JSON.stringify(value, null, 2))
        await fs.rename(temporary, Global.Path.providerModelCatalogCache)
      })
    await instanceState.writeQueue
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
    const fallbackModelIDs = profile.fallbackModels ?? []
    const mappedProvider = sourceID !== profile.id
    const modelIDs =
      mappedProvider && fallbackModelIDs.length > 0
        ? fallbackModelIDs
        : [...new Set([...sourceModelIDs, ...fallbackModelIDs])]
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

  export async function metadata(input?: { config?: unknown }): Promise<Record<string, ProviderProfile.Metadata>> {
    const providers = await resolve(input)
    return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, providerMetadata(provider)]))
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
    const environmentValues = ScopeContext.tryScope() ? Env.all() : RuntimeContext.current().host.env
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
    const instanceState = runtimeState()

    if (!profile.fetchModelCatalog && !profile.fetchModels) return provider
    const auth = context?.auth
    if (!auth && profile.authKind !== "none") {
      instanceState.catalogStates.delete(catalogStateKey(providerID))
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
    instanceState.catalogStates.set(catalogStateKey(providerID), {
      source:
        snapshot && key && instanceState.freshlyVerified.has(key)
          ? "live"
          : snapshot
            ? neverVerified
              ? "bundled"
              : "cached"
            : "bundled",
      refreshing: key ? instanceState.refreshInFlight.has(key) || instanceState.scheduledRefreshes.has(key) : false,
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
    const instanceState = runtimeState()

    if (instanceState.shutdown.signal.aborted) return
    const current = instanceState.retryTimers.get(providerID)
    if (current) clearTimeout(current)
    const timer = setTimeout(
      () => {
        instanceState.retryTimers.delete(providerID)
        void refreshAndReload(providerID, profileID, baseURL, configured)
      },
      retryDelay({ failure, retryAfterMs: retryAfterMs(error) }),
    )
    timer.unref()
    instanceState.retryTimers.set(providerID, timer)
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

  export function refresh(
    providerID: string,
    profileID?: string,
    baseURL?: string,
    configuredInput?: ConfiguredProvider,
  ): Promise<ModelCatalogState> {
    return tracked(() => refreshCatalog(providerID, profileID, baseURL, configuredInput))
  }

  async function refreshCatalog(
    providerID: string,
    profileID?: string,
    baseURL?: string,
    configuredInput?: ConfiguredProvider,
  ): Promise<ModelCatalogState> {
    const instanceState = runtimeState()

    registerBuiltinProviderProfiles()
    await registerPluginProfiles()
    let profile = ProviderProfile.resolve(providerID, profileID)
    let configured = configuredInput
    if (ScopeContext.tryScope() && (!configured || profileID === undefined || baseURL === undefined)) {
      const { Config } = await import("../config/config")
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
    const pending = instanceState.refreshInFlight.get(key)
    if (pending) return pending

    let request: Promise<ModelCatalogState>
    request = (async () => {
      const store = await readSnapshots()
      const previous = store.get(key)
      const now = Date.now()
      instanceState.catalogStates.set(catalogStateKey(providerID), {
        source: previous ? (instanceState.freshlyVerified.has(key) ? "live" : "cached") : "bundled",
        refreshing: true,
        modelCount: previous?.activeModels.length ?? 0,
        lastVerifiedAt: previous?.lastVerifiedAt,
        failure: previous?.failure,
      })

      let entries: ProviderProfile.ModelCatalogEntry[]
      const catalogFetch: ProviderProfile.FetchLike = (input, init) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        return fetch(input, {
          ...init,
          signal: signal ? AbortSignal.any([signal, instanceState.shutdown.signal]) : instanceState.shutdown.signal,
        })
      }
      try {
        entries = profile.fetchModelCatalog
          ? await profile.fetchModelCatalog({
              providerID,
              auth: context.auth,
              fetch: catalogFetch,
              baseURL: resolvedBaseURL,
            })
          : (
              await profile.fetchModels!({
                providerID,
                auth: context.auth,
                fetch: catalogFetch,
                baseURL: resolvedBaseURL,
              })
            ).map((id) => ({ id }))
        if (entries.length === 0)
          throw Object.assign(new Error("provider returned an empty model catalog"), {
            catalogFailure: "invalid_response",
          })
      } catch (error) {
        instanceState.shutdown.signal.throwIfAborted()
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
        instanceState.memoryCache.clear()
        const state: ModelCatalogState = {
          source: previous ? (instanceState.freshlyVerified.has(key) ? "live" : "cached") : "bundled",
          refreshing: false,
          modelCount: failed.activeModels.length,
          lastVerifiedAt: failed.lastVerifiedAt,
          failure,
        }
        instanceState.catalogStates.set(catalogStateKey(providerID), state)
        scheduleRetry(providerID, profile.id, resolvedBaseURL, configured, failure, error)
        log.warn("failed to refresh provider model catalog", { providerID, profileID: profile.id, failure, error })
        return state
      }

      instanceState.shutdown.signal.throwIfAborted()
      const next = mergeRefresh(previous, entries, { providerID, identityHash: context.identityHash, now })
      store.set(key, next)
      await persistSnapshots(key)
      instanceState.memoryCache.clear()
      instanceState.freshlyVerified.add(key)
      const retry = instanceState.retryTimers.get(providerID)
      if (retry) clearTimeout(retry)
      instanceState.retryTimers.delete(providerID)
      const state: ModelCatalogState = {
        source: "live",
        refreshing: false,
        modelCount: next.activeModels.length,
        lastVerifiedAt: next.lastVerifiedAt,
      }
      instanceState.catalogStates.set(catalogStateKey(providerID), state)
      return state
    })().finally(() => {
      if (instanceState.refreshInFlight.get(key) === request) instanceState.refreshInFlight.delete(key)
      instanceState.scheduledRefreshes.delete(key)
    })
    instanceState.refreshInFlight.set(key, request)
    return request
  }

  async function refreshAndReload(
    providerID: string,
    profileID?: string,
    baseURL?: string,
    configured?: ConfiguredProvider,
  ) {
    if (runtimeState().shutdown.signal.aborted) return
    return tracked(async () => {
      try {
        await refresh(providerID, profileID, baseURL, configured)
        if (runtimeState().shutdown.signal.aborted) return
        const { RuntimeReloadExecutor } = await import("../config/reload-executor")
        if (runtimeState().shutdown.signal.aborted) return
        await RuntimeReloadExecutor.reload({ targets: ["provider"], reason: "provider model catalog refreshed" })
      } catch (error) {
        log.warn("failed to apply provider model catalog refresh", { providerID, error })
      }
    })
  }

  function scheduleRefresh(
    providerID: string,
    profile: ProviderProfile.Profile,
    context: LiveDiscoveryContext,
    baseURL: string | undefined,
    configured: ConfiguredProvider | undefined,
    snapshot: Snapshot | undefined,
  ) {
    const instanceState = runtimeState()

    if (instanceState.shutdown.signal.aborted) return
    if (!context.auth && profile.authKind !== "none") return
    const now = Date.now()
    const verifiedRecently = snapshot?.lastVerifiedAt && now - snapshot.lastVerifiedAt < DEFAULT_CACHE_TTL_MS
    const failedRecently = snapshot?.failure && now - snapshot.lastAttemptAt < RETRY_DELAY_MS
    if (verifiedRecently || failedRecently) return
    const key = snapshotKey(providerID, context.identityHash)
    if (instanceState.refreshInFlight.has(key) || instanceState.scheduledRefreshes.has(key)) return
    instanceState.scheduledRefreshes.add(key)
    queueMicrotask(() => {
      void refreshAndReload(providerID, profile.id, baseURL, configured).finally(() =>
        instanceState.scheduledRefreshes.delete(key),
      )
    })
  }

  function tracked<T>(body: () => Promise<T>): Promise<T> {
    const state = runtimeState()
    state.shutdown.signal.throwIfAborted()
    const task = body()
    state.jobs.add(task)
    return task.finally(() => state.jobs.delete(task))
  }

  export function resolve(input?: {
    config?: unknown
    includeLive?: boolean
    refresh?: boolean
    forceRefresh?: boolean
  }) {
    return tracked(() => resolveCatalog(input))
  }

  async function resolveCatalog(input?: {
    config?: unknown
    includeLive?: boolean
    refresh?: boolean
    forceRefresh?: boolean
  }): Promise<Record<string, ModelsDev.Provider>> {
    const instanceState = runtimeState()

    registerBuiltinProviderProfiles()
    await registerPluginProfiles()
    const liveContexts = await resolveLiveDiscoveryContexts(input?.includeLive, input?.config)
    const key = cacheKey(input, liveContexts)
    const cached = instanceState.memoryCache.get(key)
    if (!input?.forceRefresh && cached && Date.now() - cached.createdAt < cached.ttlMs) {
      return cached.value
    }
    const pending = instanceState.inFlight.get(key)
    if (!input?.forceRefresh && pending) return pending
    const generation = instanceState.cacheGeneration
    let request: Promise<Record<string, ModelsDev.Provider>>
    request = doResolve(input, liveContexts, key, generation).finally(() => {
      if (instanceState.inFlight.get(key) === request) instanceState.inFlight.delete(key)
    })
    instanceState.inFlight.set(key, request)
    return request
  }

  function cacheKey(
    input: { config?: unknown; includeLive?: boolean; refresh?: boolean } | undefined,
    liveContexts: Map<string, LiveDiscoveryTarget>,
  ) {
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
    return JSON.stringify({
      includeLive: input?.includeLive === true,
      refresh: input?.refresh !== false,
      connections,
      liveIdentities,
    })
  }

  async function doResolve(
    input: { config?: unknown; includeLive?: boolean; refresh?: boolean } | undefined,
    liveContexts: Map<string, LiveDiscoveryTarget>,
    key: string,
    generation: number,
  ): Promise<Record<string, ModelsDev.Provider>> {
    const instanceState = runtimeState()

    const runtimeModelsCatalog = await loadModelsCatalogRuntime()
    const modelsDev = withBuiltinSourceSurfaces(await runtimeModelsCatalog.get())
    const result: Record<string, ModelsDev.Provider> = { ...modelsDev }

    for (const [providerID, provider] of Object.entries(bundledSnapshot(modelsDev))) {
      result[providerID] = mergeProvider(result[providerID], provider)
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
        const state = instanceState.catalogStates.get(catalogStateKey(providerID))
        if (state && target.configured) {
          instanceState.catalogStates.set(catalogStateKey(providerID), {
            ...state,
            modelCount: Object.values(projected.models).filter((model) => model.catalog_state !== "retained").length,
          })
        }
        if (input.refresh !== false && (target.profile.fetchModelCatalog || target.profile.fetchModels)) {
          const snapshot = (await readSnapshots()).get(snapshotKey(providerID, target.context.identityHash))
          scheduleRefresh(providerID, target.profile, target.context, target.baseURL, target.configured, snapshot)
        }
      }
    }

    if (generation === instanceState.cacheGeneration) {
      instanceState.memoryCache.set(key, {
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
    const instanceState = runtimeState()

    instanceState.cacheGeneration++
    instanceState.memoryCache.clear()
    instanceState.inFlight.clear()
  }

  export async function stop() {
    const state = runtimeState()
    state.shutdown.abort(new Error("Provider catalog is stopping"))
    for (const timer of state.retryTimers.values()) clearTimeout(timer)
    state.retryTimers.clear()
    await Promise.allSettled(state.jobs)
    await state.writeQueue
    reset()
  }

  export function reset() {
    const instanceState = runtimeState()

    instanceState.cacheGeneration++
    for (const timer of instanceState.retryTimers.values()) clearTimeout(timer)
    instanceState.retryTimers.clear()
    instanceState.refreshInFlight.clear()
    instanceState.scheduledRefreshes.clear()
    instanceState.memoryCache.clear()
    instanceState.inFlight.clear()
    instanceState.catalogStates.clear()
    instanceState.freshlyVerified.clear()
    instanceState.snapshots = undefined
  }

  export async function subscribeModelCatalog() {
    const state = runtimeState()
    return (await loadModelsCatalogRuntime()).onRefresh(() => {
      if (state.shutdown.signal.aborted) return
      return tracked(async () => {
        invalidateModelsDevProjection()
        const { RuntimeReloadExecutor } = await import("../config/reload-executor")
        if (state.shutdown.signal.aborted) return
        await RuntimeReloadExecutor.reloadGlobal({ targets: ["provider"], reason: "models.dev catalog refreshed" })
      })
    })
  }

  export function modelCatalogState(providerID: string) {
    const instanceState = runtimeState()

    return instanceState.catalogStates.get(catalogStateKey(providerID))
  }
}
