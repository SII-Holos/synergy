import { Global } from "@/global"
import { Installation } from "@/global/installation"
import { Log } from "@/util/log"
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
  export const FALLBACK_CACHE_TTL_MS = 60 * 1000
  export const MAX_LAST_KNOWN_GOOD_ENTRIES = 100

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
    identity: string
  }

  type CacheEntry = {
    value: Record<string, ModelsDev.Provider>
    createdAt: number
    ttlMs: number
  }

  const inFlight = new Map<string, Promise<Record<string, ModelsDev.Provider>>>()
  const memoryCache = new Map<string, CacheEntry>()
  const liveDiscovery = new Map<string, "verified" | "fallback">()
  const lastKnownGood = new Map<string, ProviderProfile.ModelCatalogEntry[]>()

  function rememberLastKnownGood(key: string, entries: ProviderProfile.ModelCatalogEntry[]) {
    lastKnownGood.delete(key)
    lastKnownGood.set(
      key,
      entries.map((entry) => ({ ...entry })),
    )
    while (lastKnownGood.size > MAX_LAST_KNOWN_GOOD_ENTRIES) {
      const oldest = lastKnownGood.keys().next().value
      if (!oldest) break
      lastKnownGood.delete(oldest)
    }
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

  function applyLiveEntries(
    provider: ModelsDev.Provider,
    profile: ProviderProfile.Profile,
    modelsDev: Record<string, ModelsDev.Provider>,
    live: ProviderProfile.ModelCatalogEntry[],
  ): ModelsDev.Provider {
    const source = modelsDev[profile.modelsDevProviderID ?? profile.id]
    const metadataSource = profile.sourceModelProviderID ? modelsDev[profile.sourceModelProviderID] : undefined
    const npm = profile.aiSdkPackage ?? source?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
    const next: ModelsDev.Provider = { ...provider, models: {} }
    for (const entry of live) {
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
    }
    return next
  }

  function liveDiscoveryKey(providerID: string, identity: string) {
    return JSON.stringify({ providerID, identity })
  }

  async function resolveLiveDiscoveryContexts(includeLive: boolean | undefined) {
    const contexts = new Map<string, LiveDiscoveryContext>()
    if (!includeLive) return contexts

    registerBuiltinProviderProfiles()
    for (const profile of ProviderProfile.all()) {
      if (!profile.fetchModelCatalog && !profile.fetchModels) continue
      const selected = await Auth.select(profile.id)
      const authUpdatedAt = selected?.poolEntry?.updatedAt ?? selected?.entry.updatedAt
      const identity = await profile.modelCatalogIdentity?.({
        auth: selected?.auth,
        credentialID: selected?.credentialID,
        authUpdatedAt,
      })
      contexts.set(profile.id, {
        auth: selected?.auth,
        identity:
          identity ??
          (selected
            ? JSON.stringify({ credentialID: selected.credentialID, authUpdatedAt })
            : profile.authKind === "none"
              ? "anonymous"
              : "unauthenticated"),
      })
    }
    return contexts
  }

  async function applyLiveDiscovery(
    provider: ModelsDev.Provider,
    profile: ProviderProfile.Profile,
    modelsDev: Record<string, ModelsDev.Provider>,
    context: LiveDiscoveryContext | undefined,
  ): Promise<{ provider: ModelsDev.Provider; degraded: boolean }> {
    if (!profile.fetchModelCatalog && !profile.fetchModels) return { provider, degraded: false }
    const auth = context?.auth
    if (!auth && profile.authKind !== "none") {
      liveDiscovery.delete(profile.id)
      return { provider, degraded: false }
    }
    let live: ProviderProfile.ModelCatalogEntry[] = []
    try {
      live = profile.fetchModelCatalog
        ? await profile.fetchModelCatalog({ auth, fetch, baseURL: profile.baseURL })
        : (await profile.fetchModels!({ auth, fetch, baseURL: profile.baseURL })).map((id) => ({ id }))
    } catch (error) {
      log.warn("failed to fetch live provider models", { providerID: profile.id, error })
    }
    const lkgKey = context ? liveDiscoveryKey(profile.id, context.identity) : undefined
    if (!live.length) {
      liveDiscovery.set(profile.id, "fallback")
      const previous = lkgKey ? lastKnownGood.get(lkgKey) : undefined
      return {
        provider: previous ? applyLiveEntries(provider, profile, modelsDev, previous) : provider,
        degraded: true,
      }
    }
    liveDiscovery.set(profile.id, "verified")
    if (lkgKey) rememberLastKnownGood(lkgKey, live)
    return { provider: applyLiveEntries(provider, profile, modelsDev, live), degraded: false }
  }

  export async function resolve(input?: {
    config?: unknown
    includeLive?: boolean
    forceRefresh?: boolean
  }): Promise<Record<string, ModelsDev.Provider>> {
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
      [...liveContexts.entries()].map(([providerID, context]) => [providerID, context.identity]),
    )
    return JSON.stringify({ includeLive: input?.includeLive === true, providerCatalog, liveIdentities })
  }

  async function doResolve(
    input: { config?: unknown; includeLive?: boolean } | undefined,
    liveContexts: Map<string, LiveDiscoveryContext>,
    key: string,
  ): Promise<Record<string, ModelsDev.Provider>> {
    registerBuiltinProviderProfiles()
    await registerPluginProfiles()
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

    let degraded = false
    if (input?.includeLive) {
      for (const profile of ProviderProfile.all()) {
        const provider = result[profile.id]
        if (!provider) continue
        const discovery = await applyLiveDiscovery(provider, profile, modelsDev, liveContexts.get(profile.id))
        result[profile.id] = discovery.provider
        degraded ||= discovery.degraded
      }
    }

    memoryCache.set(key, {
      value: result,
      createdAt: Date.now(),
      ttlMs: degraded ? FALLBACK_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS,
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
    memoryCache.clear()
    inFlight.clear()
    liveDiscovery.clear()
    lastKnownGood.clear()
  }

  export function liveDiscoveryStatus(providerID: string) {
    return liveDiscovery.get(providerID)
  }
}
