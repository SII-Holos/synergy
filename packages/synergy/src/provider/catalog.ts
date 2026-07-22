import { Global } from "@/global"
import { Installation } from "@/global/installation"
import { Log } from "@/util/log"
import fs from "fs/promises"
import { mergeDeep } from "remeda"
import z from "zod"
import { Auth } from "./api-key"
import { registerBuiltinProviderProfiles } from "./builtin"
import { CodexProvider } from "./codex"
import { ModelsDev } from "./models"
import { ProviderProfile } from "./profile"
import { normalizeImageMediaTypes } from "./image-capability"

export namespace ProviderCatalog {
  const log = Log.create({ service: "provider.catalog" })

  export const DEFAULT_REGISTRY_URL =
    "https://raw.githubusercontent.com/SII-Holos/synergy-provider-registry/main/catalog.v1.json"
  export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000
  export const DEFAULT_PUBLIC_KEY = "h4Y782Oylib+BlO2/7AKO5vY6skpCmTZNhqr3GRoBxA="
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

  function snapshotKey(providerID: string, identityHash: string) {
    return `${providerID}:${identityHash}`
  }

  async function hashIdentity(providerID: string, identity: string) {
    const bytes = new TextEncoder().encode(`${providerID}\u0000${identity}`)
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
      const context = await resolveLiveDiscoveryContext(profile).catch(() => undefined)
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

  export function providerMetadata(provider: ProviderMetadataSource): ProviderProfile.Metadata {
    const profile = ProviderProfile.get(provider.id)
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

  async function readCachedRemote(config: Config): Promise<RemoteCatalog | undefined> {
    if (!config.offlineCache) return undefined
    const file = Bun.file(Global.Path.providerCatalogCache)
    const stat = await file.stat().catch(() => undefined)
    if (!stat || Date.now() - stat.mtimeMs > config.cacheTtlMs) return undefined
    const parsed = RemoteCatalog.safeParse(await file.json().catch(() => undefined))
    return parsed.success ? parsed.data : undefined
  }

  async function fetchRemote(config: Config): Promise<RemoteCatalog | undefined> {
    if (!config.enabled) return readCachedRemote(config)
    if (process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH === "true") return readCachedRemote(config)
    if (!config.publicKey.trim()) return readCachedRemote(config)
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
    if (!catalogResponse?.ok || !signatureResponse?.ok) return readCachedRemote(config)
    const text = await catalogResponse.text()
    const signature = (await signatureResponse.text()).trim()
    if (!(await verifySignature(text, signature, config.publicKey))) return readCachedRemote(config)
    const parsed = RemoteCatalog.safeParse(JSON.parse(text))
    if (!parsed.success) return readCachedRemote(config)
    await Bun.write(Global.Path.providerCatalogCache, JSON.stringify(parsed.data, null, 2)).catch(() => {})
    return parsed.data
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

  async function resolveLiveDiscoveryContext(profile: ProviderProfile.Profile): Promise<LiveDiscoveryContext> {
    const selected = await Auth.select(profile.id)
    const authUpdatedAt = selected?.poolEntry?.updatedAt ?? selected?.entry.updatedAt
    const customIdentity = await profile.modelCatalogIdentity?.({
      auth: selected?.auth,
      credentialID: selected?.credentialID,
      authUpdatedAt,
    })
    const identity =
      customIdentity ??
      (selected ? selected.credentialID : profile.authKind === "none" ? "anonymous" : "unauthenticated")
    return { auth: selected?.auth, identityHash: await hashIdentity(profile.id, identity) }
  }

  async function resolveLiveDiscoveryContexts(includeLive: boolean | undefined) {
    const contexts = new Map<string, LiveDiscoveryContext>()
    if (!includeLive) return contexts

    registerBuiltinProviderProfiles()
    for (const profile of ProviderProfile.all()) {
      if (!profile.fetchModelCatalog && !profile.fetchModels) continue
      contexts.set(profile.id, await resolveLiveDiscoveryContext(profile))
    }
    return contexts
  }

  async function applyCachedDiscovery(
    provider: ModelsDev.Provider,
    profile: ProviderProfile.Profile,
    modelsDev: Record<string, ModelsDev.Provider>,
    context: LiveDiscoveryContext | undefined,
  ): Promise<ModelsDev.Provider> {
    if (!profile.fetchModelCatalog && !profile.fetchModels) return provider
    const auth = context?.auth
    if (!auth && profile.authKind !== "none") {
      catalogStates.delete(profile.id)
      return provider
    }
    const key = context ? snapshotKey(profile.id, context.identityHash) : undefined
    const snapshot = key ? (await readSnapshots()).get(key) : undefined
    const modelCount = snapshot?.activeModels.length ?? Object.keys(provider.models).length
    catalogStates.set(profile.id, {
      source: snapshot && key && freshlyVerified.has(key) ? "live" : snapshot ? "cached" : "bundled",
      refreshing: refreshInFlight.has(profile.id) || scheduledRefreshes.has(profile.id),
      modelCount,
      lastVerifiedAt: snapshot?.lastVerifiedAt,
      failure: snapshot?.failure,
    })
    if (!snapshot) return provider
    return applySnapshotEntries(provider, profile, modelsDev, snapshot)
  }

  function retryAfterMs(error: unknown) {
    if (!error || typeof error !== "object") return undefined
    const record = error as Record<string, unknown>
    if (typeof record.retryAfterMs === "number") return record.retryAfterMs
    if (typeof record.retryAfterSeconds === "number") return record.retryAfterSeconds * 1000
    return undefined
  }

  function scheduleRetry(providerID: string, failure: Failure, error?: unknown) {
    const current = retryTimers.get(providerID)
    if (current) clearTimeout(current)
    const timer = setTimeout(
      () => {
        retryTimers.delete(providerID)
        void refreshAndReload(providerID)
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

  export async function refresh(providerID: string): Promise<ModelCatalogState> {
    registerBuiltinProviderProfiles()
    await registerPluginProfiles()
    const profile = ProviderProfile.get(providerID)
    if (!profile?.fetchModelCatalog && !profile?.fetchModels) {
      return { source: "bundled", refreshing: false, modelCount: 0 }
    }
    const context = await resolveLiveDiscoveryContext(profile)
    const key = snapshotKey(profile.id, context.identityHash)
    const pending = refreshInFlight.get(profile.id)
    if (pending) return pending

    let request: Promise<ModelCatalogState>
    request = (async () => {
      const store = await readSnapshots()
      const previous = store.get(key)
      const now = Date.now()
      catalogStates.set(profile.id, {
        source: previous ? (freshlyVerified.has(key) ? "live" : "cached") : "bundled",
        refreshing: true,
        modelCount: previous?.activeModels.length ?? 0,
        lastVerifiedAt: previous?.lastVerifiedAt,
        failure: previous?.failure,
      })

      let entries: ProviderProfile.ModelCatalogEntry[]
      try {
        entries = profile.fetchModelCatalog
          ? await profile.fetchModelCatalog({ auth: context.auth, fetch, baseURL: profile.baseURL })
          : (await profile.fetchModels!({ auth: context.auth, fetch, baseURL: profile.baseURL })).map((id) => ({ id }))
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
          providerID: profile.id,
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
        catalogStates.set(profile.id, state)
        scheduleRetry(profile.id, failure, error)
        log.warn("failed to refresh provider model catalog", { providerID: profile.id, failure, error })
        return state
      }

      const next = mergeRefresh(previous, entries, { providerID: profile.id, identityHash: context.identityHash, now })
      store.set(key, next)
      await persistSnapshots(key)
      memoryCache.clear()
      freshlyVerified.add(key)
      const retry = retryTimers.get(profile.id)
      if (retry) clearTimeout(retry)
      retryTimers.delete(profile.id)
      const state: ModelCatalogState = {
        source: "live",
        refreshing: false,
        modelCount: next.activeModels.length,
        lastVerifiedAt: next.lastVerifiedAt,
      }
      catalogStates.set(profile.id, state)
      return state
    })().finally(() => {
      if (refreshInFlight.get(profile.id) === request) refreshInFlight.delete(profile.id)
      scheduledRefreshes.delete(profile.id)
    })
    refreshInFlight.set(profile.id, request)
    return request
  }

  async function refreshAndReload(providerID: string) {
    try {
      await refresh(providerID)
      const { RuntimeReload } = await import("@/runtime/reload")
      await RuntimeReload.reload({ targets: ["provider"], reason: "provider model catalog refreshed" })
    } catch (error) {
      log.warn("failed to apply provider model catalog refresh", { providerID, error })
    }
  }

  function scheduleRefresh(
    profile: ProviderProfile.Profile,
    context: LiveDiscoveryContext,
    snapshot: Snapshot | undefined,
  ) {
    if (!context.auth && profile.authKind !== "none") return
    const now = Date.now()
    const verifiedRecently = snapshot?.lastVerifiedAt && now - snapshot.lastVerifiedAt < DEFAULT_CACHE_TTL_MS
    const failedRecently = snapshot?.failure && now - snapshot.lastAttemptAt < RETRY_DELAY_MS
    if (verifiedRecently || failedRecently) return
    if (refreshInFlight.has(profile.id) || scheduledRefreshes.has(profile.id)) return
    scheduledRefreshes.add(profile.id)
    queueMicrotask(() => void refreshAndReload(profile.id))
  }

  export async function resolve(input?: {
    config?: unknown
    includeLive?: boolean
    forceRefresh?: boolean
  }): Promise<Record<string, ModelsDev.Provider>> {
    registerBuiltinProviderProfiles()
    await registerPluginProfiles()
    const liveContexts = await resolveLiveDiscoveryContexts(input?.includeLive)
    const key = cacheKey(input, liveContexts)
    const cached = memoryCache.get(key)
    if (!input?.forceRefresh && cached && Date.now() - cached.createdAt < cached.ttlMs) {
      return cached.value
    }
    const pending = inFlight.get(key)
    if (!input?.forceRefresh && pending) return pending
    let request: Promise<Record<string, ModelsDev.Provider>>
    request = doResolve(input, liveContexts, key).finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key)
    })
    inFlight.set(key, request)
    return request
  }

  function cacheKey(
    input: { config?: unknown; includeLive?: boolean } | undefined,
    liveContexts: Map<string, LiveDiscoveryContext>,
  ) {
    const providerCatalog = (input?.config as { providerCatalog?: unknown } | undefined)?.providerCatalog ?? {}
    const liveIdentities = Object.fromEntries(
      [...liveContexts.entries()].map(([providerID, context]) => [providerID, context.identityHash]),
    )
    return JSON.stringify({ includeLive: input?.includeLive === true, providerCatalog, liveIdentities })
  }

  async function doResolve(
    input: { config?: unknown; includeLive?: boolean } | undefined,
    liveContexts: Map<string, LiveDiscoveryContext>,
    key: string,
  ): Promise<Record<string, ModelsDev.Provider>> {
    const config = Config.parse((input?.config as any)?.providerCatalog ?? {})
    const modelsDev = withBuiltinSourceSurfaces(await ModelsDev.get())
    const result: Record<string, ModelsDev.Provider> = { ...modelsDev }

    for (const [providerID, provider] of Object.entries(bundledSnapshot(modelsDev))) {
      result[providerID] = mergeProvider(result[providerID], provider)
    }

    const remote = await fetchRemote(config)
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

    if (input?.includeLive) {
      for (const profile of ProviderProfile.all()) {
        const provider = result[profile.id]
        if (!provider) continue
        const context = liveContexts.get(profile.id)
        result[profile.id] = await applyCachedDiscovery(provider, profile, modelsDev, context)
        if (context && (profile.fetchModelCatalog || profile.fetchModels)) {
          const snapshot = (await readSnapshots()).get(snapshotKey(profile.id, context.identityHash))
          scheduleRefresh(profile, context, snapshot)
        }
      }
    }

    memoryCache.set(key, {
      value: result,
      createdAt: Date.now(),
      ttlMs: DEFAULT_CACHE_TTL_MS,
    })
    return result
  }

  async function registerPluginProfiles() {
    const { Plugin } = await import("../plugin")
    const entries = await Plugin.authProviderEntries().catch(() => [])
    ProviderProfile.clearPluginProfiles()
    for (const { contribution } of entries) {
      const profile = contribution.provider
      ProviderProfile.register({
        id: contribution.id,
        name: profile.name,
        origin: "plugin",
        aliases: profile.aliases,
        description: profile.description,
        signupUrl: profile.signupUrl,
        recommendation: profile.recommendation as ProviderProfile.Profile["recommendation"],
        env: profile.env,
        baseURL: profile.baseURL,
        modelsURL: profile.modelsURL,
        authKind: profile.authKind,
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

  export function reset() {
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
    refreshInFlight.clear()
    scheduledRefreshes.clear()
    memoryCache.clear()
    inFlight.clear()
    catalogStates.clear()
    freshlyVerified.clear()
    snapshots = undefined
  }

  export function modelCatalogState(providerID: string) {
    return catalogStates.get(providerID)
  }
}
