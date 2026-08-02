import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { Config } from "@/config/config"
import type { ModelsDev } from "./models"
import { ProviderCatalog } from "./catalog"
import { ProviderProfile } from "./profile"
import { Auth } from "./api-key"
import { Log } from "@/util/log"
import { mergeDeep } from "remeda"
import type { Provider as ConfigProvider } from "../config/schema"

export namespace ProviderConnection {
  const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      profileID: z.string(),
      catalogProviderID: z.string(),
      endpoint: z.string().optional(),
      enabled: z.boolean(),
      configured: z.boolean(),
      removable: z.boolean(),
      canCreateSibling: z.boolean(),
    })
    .strict()
    .meta({ ref: "ProviderConnection" })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z
    .object({
      profileID: z.string().min(1),
      name: z.string().trim().min(1).max(80),
      id: z.string().regex(ID_PATTERN).optional(),
      endpoint: z.string().url().optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ProviderConnectionCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      endpoint: z.string().url().nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .refine((input) => Object.keys(input).length > 0, { message: "At least one account field must be provided" })
    .meta({ ref: "ProviderConnectionUpdateInput" })
  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Removed = z
    .object({
      providerID: z.string(),
      removed: z.literal(true),
    })
    .strict()
    .meta({ ref: "ProviderConnectionRemoveResponse" })

  export const ProfileNotFound = NamedError.create(
    "ProviderConnectionProfileNotFoundError",
    z.object({ profileID: z.string() }),
  )
  export const CatalogNotFound = NamedError.create(
    "ProviderConnectionCatalogNotFoundError",
    z.object({ profileID: z.string(), catalogProviderID: z.string() }),
  )
  export const AlreadyExists = NamedError.create(
    "ProviderConnectionAlreadyExistsError",
    z.object({ providerID: z.string() }),
  )
  export const NotFound = NamedError.create("ProviderConnectionNotFoundError", z.object({ providerID: z.string() }))
  export const NotManaged = NamedError.create("ProviderConnectionNotManagedError", z.object({ providerID: z.string() }))
  export const InUse = NamedError.create(
    "ProviderConnectionInUseError",
    z.object({ providerID: z.string(), references: z.array(z.string()) }),
  )

  type ProviderConfig = NonNullable<Config.Info["provider"]>[string]

  function enabled(providerID: string, config: Pick<Config.Info, "enabled_providers" | "disabled_providers">) {
    if (config.disabled_providers?.includes(providerID)) return false
    if (config.enabled_providers && !config.enabled_providers.includes(providerID)) return false
    return true
  }

  function configuredEndpoint(provider: ProviderConfig | undefined) {
    return provider?.api ?? (typeof provider?.options?.baseURL === "string" ? provider.options.baseURL : undefined)
  }

  function connectionInfo(providerID: string, config: Config.Info, catalog: Record<string, ModelsDev.Provider>): Info {
    const configured = config.provider?.[providerID]
    const profile = ProviderProfile.resolve(providerID, configured?.profile)
    const profileID = profile?.id ?? configured?.profile ?? configured?.modelsDevProviderID ?? providerID
    const catalogProviderID = configured?.modelsDevProviderID ?? profile?.modelsDevProviderID ?? profileID
    return {
      id: providerID,
      name: configured?.name ?? catalog[providerID]?.name ?? profile?.name ?? providerID,
      profileID,
      catalogProviderID,
      ...(configuredEndpoint(configured) ? { endpoint: configuredEndpoint(configured) } : {}),
      enabled: enabled(providerID, config),
      configured: configured !== undefined,
      removable:
        configured !== undefined &&
        (configured.profile !== undefined || configured.modelsDevProviderID !== undefined) &&
        providerID !== profileID,
      canCreateSibling: catalog[catalogProviderID] !== undefined,
    }
  }

  export function listFrom(config: Config.Info, catalog: Record<string, ModelsDev.Provider>): Record<string, Info> {
    const ids = new Set([...Object.keys(catalog), ...Object.keys(config.provider ?? {})])
    return Object.fromEntries([...ids].map((providerID) => [providerID, connectionInfo(providerID, config, catalog)]))
  }

  export async function list(): Promise<Record<string, Info>> {
    const config = await Config.globalResolved()
    const catalog = await ProviderCatalog.resolve({ config, includeLive: false })
    return listFrom(config, catalog)
  }

  function slug(value: string) {
    return value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 64)
  }

  function allocateID(input: CreateInput, occupied: Set<string>) {
    if (input.id) {
      if (occupied.has(input.id)) throw new AlreadyExists({ providerID: input.id })
      return input.id
    }
    const stem = slug(`${input.profileID}-${input.name}`) || slug(`${input.profileID}-account`)
    let providerID = stem
    let suffix = 2
    while (occupied.has(providerID)) {
      const nextSuffix = `-${suffix++}`
      providerID = `${stem.slice(0, 64 - nextSuffix.length)}${nextSuffix}`
    }
    return providerID
  }

  function withEnabledState(config: Config.Info, providerID: string, nextEnabled: boolean): Config.Info {
    const disabled = new Set(config.disabled_providers ?? [])
    const allow = config.enabled_providers ? new Set(config.enabled_providers) : undefined
    if (nextEnabled) {
      disabled.delete(providerID)
      allow?.add(providerID)
    } else {
      disabled.add(providerID)
    }
    return {
      ...config,
      ...(allow ? { enabled_providers: [...allow] } : {}),
      disabled_providers: [...disabled],
    }
  }

  function withoutEnabledState(config: Config.Info, providerID: string): Config.Info {
    return {
      ...config,
      ...(config.enabled_providers
        ? { enabled_providers: config.enabled_providers.filter((item) => item !== providerID) }
        : {}),
      disabled_providers: (config.disabled_providers ?? []).filter((item) => item !== providerID),
    }
  }

  function usesProvider(model: string | undefined, providerID: string) {
    return model?.startsWith(`${providerID}/`) === true
  }

  function references(config: Config.Info, providerID: string) {
    const result: string[] = []
    const modelRoles = [
      "model",
      "nano_model",
      "mini_model",
      "mid_model",
      "thinking_model",
      "long_context_model",
      "creative_model",
      "vision_model",
    ] as const
    for (const role of modelRoles) {
      if (usesProvider(config[role], providerID)) result.push(role)
    }
    for (const [agentID, agent] of Object.entries(config.agent ?? {})) {
      if (usesProvider(agent.model, providerID)) result.push(`agent.${agentID}.model`)
    }
    for (const [commandID, command] of Object.entries(config.command ?? {})) {
      if (usesProvider(command.model, providerID)) result.push(`command.${commandID}.model`)
    }
    for (const [agentID, agent] of Object.entries(config.external_agent ?? {})) {
      if (usesProvider(agent.model, providerID)) result.push(`external_agent.${agentID}.model`)
    }
    for (const [categoryID, category] of Object.entries(config.category ?? {})) {
      if (usesProvider(category.model, providerID)) result.push(`category.${categoryID}.model`)
    }
    for (const [index, model] of (config.quick_switcher?.models ?? []).entries()) {
      if (model.providerID === providerID) result.push(`quick_switcher.models[${index}]`)
    }
    for (const [channelID, channel] of Object.entries(config.channel ?? {})) {
      if (channel.type !== "feishu") continue
      for (const [accountID, account] of Object.entries(channel.accounts)) {
        if (usesProvider(account.model, providerID)) {
          result.push(`channel.${channelID}.accounts.${accountID}.model`)
        }
      }
    }
    return result
  }

  export async function create(input: CreateInput) {
    const parsed = CreateInput.parse(input)
    let providerID = ""
    let catalog: Record<string, ModelsDev.Provider> = {}
    const { change } = await Config.domainMutateWithChange(
      "providers",
      async (domain) => {
        const resolved = await Config.globalResolved()
        catalog = await ProviderCatalog.resolve({ config: resolved, includeLive: false })
        const canonicalProfileID = ProviderProfile.canonicalID(parsed.profileID)
        const profile = ProviderProfile.get(canonicalProfileID)
        const profileID = profile?.id ?? canonicalProfileID
        const catalogProviderID = profile?.modelsDevProviderID ?? profileID
        if (!profile && !catalog[catalogProviderID]) throw new ProfileNotFound({ profileID: parsed.profileID })
        if (!catalog[catalogProviderID]) throw new CatalogNotFound({ profileID, catalogProviderID })
        const occupied = new Set([
          ...Object.keys(catalog),
          ...Object.keys(domain.provider ?? {}),
          ...ProviderProfile.all().map((item) => item.id),
        ])
        providerID = allocateID({ ...parsed, profileID }, occupied)
        const provider: ProviderConfig = {
          ...(profile ? { profile: profileID } : {}),
          modelsDevProviderID: catalogProviderID,
          name: parsed.name,
          ...(parsed.endpoint ? { api: parsed.endpoint } : {}),
        }
        const next = withEnabledState(
          {
            ...domain,
            provider: {
              ...(domain.provider ?? {}),
              [providerID]: provider,
            },
          },
          providerID,
          parsed.enabled ?? true,
        )
        return next
      },
      { mode: "replace-domain" },
    )
    return {
      connection: connectionInfo(providerID, change.config, catalog),
      change,
    }
  }

  export async function update(providerID: string, input: UpdateInput) {
    const parsedProviderID = z.string().min(1).parse(providerID)
    const parsed = UpdateInput.parse(input)
    const { change } = await Config.domainMutateWithChange(
      "providers",
      (domain) => {
        const current = domain.provider?.[parsedProviderID]
        if (!current) throw new NotFound({ providerID: parsedProviderID })
        const ownerID = current.profile ?? current.modelsDevProviderID
        if (!ownerID || parsedProviderID === ownerID) throw new NotManaged({ providerID: parsedProviderID })
        const provider: ProviderConfig = {
          ...current,
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        }
        if (parsed.endpoint !== undefined) {
          if (parsed.endpoint === null) delete provider.api
          else provider.api = parsed.endpoint
          if (provider.options && "baseURL" in provider.options) {
            const options = { ...provider.options }
            delete options.baseURL
            if (Object.keys(options).length === 0) delete provider.options
            else provider.options = options
          }
        }
        let next: Config.Info = {
          ...domain,
          provider: {
            ...(domain.provider ?? {}),
            [parsedProviderID]: provider,
          },
        }
        if (parsed.enabled !== undefined) next = withEnabledState(next, parsedProviderID, parsed.enabled)
        return next
      },
      { mode: "replace-domain" },
    )
    const catalog = await ProviderCatalog.resolve({ config: change.config, includeLive: false })
    return {
      connection: connectionInfo(parsedProviderID, change.config, catalog),
      change,
    }
  }

  export async function remove(providerID: string) {
    const parsedProviderID = z.string().min(1).parse(providerID)
    const config = await Config.globalResolved()
    const current = config.provider?.[parsedProviderID]
    if (!current) throw new NotFound({ providerID: parsedProviderID })
    const ownerID = current.profile ?? current.modelsDevProviderID
    if (!ownerID || parsedProviderID === ownerID) throw new NotManaged({ providerID: parsedProviderID })
    const referencedBy = references(config, parsedProviderID)
    if (referencedBy.length > 0) throw new InUse({ providerID: parsedProviderID, references: referencedBy })
    const { change } = await Config.domainMutateWithChange(
      "providers",
      (domain) => {
        const current = domain.provider?.[parsedProviderID]
        if (!current) throw new NotFound({ providerID: parsedProviderID })
        const ownerID = current.profile ?? current.modelsDevProviderID
        if (!ownerID || parsedProviderID === ownerID) throw new NotManaged({ providerID: parsedProviderID })
        const providers = { ...(domain.provider ?? {}) }
        delete providers[parsedProviderID]
        return withoutEnabledState({ ...domain, provider: providers }, parsedProviderID)
      },
      { mode: "replace-domain" },
    )
    await Auth.remove(parsedProviderID)
    return {
      result: { providerID: parsedProviderID, removed: true as const },
      change,
    }
  }
}

/**
 * Single owner for "connection ID → runtime behavior" resolution.
 *
 * Before this module, each consumer (catalog refresh, provider init, auth
 * retarget, usage service, setup probes, transform) independently decided how
 * a connection ID maps to a profile, a catalog source, a base URL and an env
 * list. Those implementations drifted (e.g. `refresh()` silently degraded to
 * bundled outside a scope, copilot lost the environment fallback for mapped
 * connections, env classification missed profile env). Everything that needs
 * connection semantics goes through here.
 *
 * Layer order for composition (from the review of PR #990):
 *   1. catalog  → models (source projected onto the connection ID)
 *   2. profile  → runtime behavior (resolveAuth / modelOptions / runtimeOptions)
 *   3. connection → local overrides (api → baseURL, options, model rules)
 * Overrides always win.
 */
export namespace ProviderConnection {
  const log = Log.create({ service: "provider.connection" })

  /** Resolver input shared by persisted configuration and runtime consumers. */
  export type ConfiguredProvider = Pick<
    ConfigProvider,
    "modelsDevProviderID" | "name" | "api" | "npm" | "env" | "options" | "models" | "whitelist" | "blacklist"
  > & { profile?: string }

  export type ConnectionConfig = { provider?: Record<string, ConfiguredProvider> }
  export interface CatalogSet {
    /** Runtime catalog, including connection-scoped live projections. */
    runtime: Record<string, ModelsDev.Provider>
    /** Static catalog without credential-scoped live discovery results. */
    inherited: Record<string, ModelsDev.Provider>
  }
  function sourceCatalog(catalogs: CatalogSet, modelsDevProviderID: string | undefined) {
    return modelsDevProviderID ? catalogs.inherited : catalogs.runtime
  }

  /** Fully-resolved semantics for one connection. Never partially resolved. */
  export interface ConnectionDefinition {
    connectionID: string
    /** Behavior source; undefined for plain config-only providers. */
    profile: ProviderProfile.Profile | undefined
    /** True when the connection ID differs from its behavior profile id. */
    isMapped: boolean
    /** Catalog source: an explicit source override, otherwise the profile projection or connection itself. */
    catalogSourceID: string
    /** Explicit Phase 1 catalog inheritance, when configured. */
    modelsDevProviderID: string | undefined
    /** Behavior profile id (explicit config or the canonical profile itself). */
    profileID: string | undefined
    /** Derived base URL: options.baseURL ?? api ?? profile.baseURL ?? catalog API. */
    baseURL: string | undefined
    /** Unified env rule without leaking canonical credentials into mapped connections. */
    env: string[]
    configured: ConfiguredProvider | undefined
  }

  export type ResolveResult =
    | { ok: true; connection: ConnectionDefinition }
    | { ok: false; reason: "unknown_profile"; connectionID: string; profileID?: string }
    | { ok: false; reason: "unknown_catalog_source"; connectionID: string; catalogSourceID: string }

  export type ResolveAllResult =
    | { ok: true; connections: Record<string, ConnectionDefinition> }
    | { ok: false; failures: Array<Extract<ResolveResult, { ok: false }>> }

  /** Resolve one connection ID against config and the authoritative catalogs. */
  export function resolveConnection(
    connectionID: string,
    config: ConnectionConfig | undefined,
    catalogs: CatalogSet,
  ): ResolveResult {
    const configured = config?.provider?.[connectionID]
    const explicitProfileID = configured?.profile
    const profile = explicitProfileID ? ProviderProfile.get(explicitProfileID) : ProviderProfile.get(connectionID)

    if (explicitProfileID && !profile) {
      log.warn("configured provider profile not found", { providerID: connectionID, profileID: explicitProfileID })
      return { ok: false, reason: "unknown_profile", connectionID, profileID: explicitProfileID }
    }

    const catalogSourceID = configured?.modelsDevProviderID ?? profile?.id ?? connectionID
    const source = sourceCatalog(catalogs, configured?.modelsDevProviderID)[catalogSourceID]
    if (configured?.modelsDevProviderID && !source) {
      return { ok: false, reason: "unknown_catalog_source", connectionID, catalogSourceID }
    }
    const isMapped = profile ? connectionID !== profile.id : false
    const env =
      configured?.env ?? profile?.env ?? (!isMapped && !configured?.modelsDevProviderID ? source?.env : undefined) ?? []
    // Catalog endpoints describe transport, not credential ownership, so explicit inheritance may safely reuse them.
    const baseURL =
      (typeof configured?.options?.baseURL === "string" ? configured.options.baseURL : undefined) ??
      configured?.api ??
      profile?.baseURL ??
      source?.api

    return {
      ok: true,
      connection: {
        connectionID,
        profile,
        isMapped,
        catalogSourceID,
        modelsDevProviderID: configured?.modelsDevProviderID,
        profileID: explicitProfileID ?? (profile ? profile.id : undefined),
        baseURL,
        env,
        configured,
      },
    }
  }

  /** Resolve every registered canonical profile plus every configured connection. */
  export function resolveAllConnections(config: ConnectionConfig | undefined, catalogs: CatalogSet): ResolveAllResult {
    const connections: Record<string, ConnectionDefinition> = {}
    const failures: Array<Extract<ResolveResult, { ok: false }>> = []
    const connectionIDs = new Set([
      ...ProviderProfile.all().map((profile) => profile.id),
      ...Object.keys(config?.provider ?? {}),
    ])
    for (const connectionID of connectionIDs) {
      const resolved = resolveConnection(connectionID, config, catalogs)
      if (resolved.ok) {
        connections[connectionID] = resolved.connection
        continue
      }
      failures.push(resolved)
    }
    if (failures.length > 0) return { ok: false, failures }
    return { ok: true, connections }
  }

  export interface ComposeInput {
    connection: ConnectionDefinition
    catalogs: CatalogSet
    auth?: Auth.Info
  }

  export interface ComposedProviderSpec {
    providerID: string
    profileID: string | undefined
    /** Source provider after projection onto the connection ID. */
    catalogSource: ModelsDev.Provider | undefined
    /** Models after source projection + configured model rules. */
    models: Record<string, ModelsDev.Model>
    /** Upstream API model id for each connection-scoped model key. */
    modelApiIDs: Record<string, string>
    /** Final options: profile runtime options merged under connection overrides. */
    options: Record<string, unknown>
    /** Options from the catalog source (for worker plan serialization). */
    baseOptions: Record<string, unknown>
    /** Connection-level overrides (api → baseURL, options). */
    explicitOptions: Record<string, unknown>
    env: string[]
    api: string | undefined
    npm: string | undefined
    baseURL: string | undefined
  }

  export type ComposeResult =
    | { ok: true; spec: ComposedProviderSpec }
    | {
        ok: false
        reason: "unknown_catalog_source"
        connectionID: string
        catalogSourceID: string
      }

  function fallbackModel(provider: ModelsDev.Provider, modelID: string): ModelsDev.Model {
    return {
      id: modelID,
      name: modelID,
      family: modelID.split(/[-/:]/)[0] || modelID,
      release_date: "2026-06-25",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: { context: 128000, input: 96000, output: 32000 },
      options: {},
      modalities: { input: ["text"], output: ["text"] },
    }
  }

  function applyModelRules(
    source: ModelsDev.Provider,
    configured: ConfiguredProvider | undefined,
  ): { models: Record<string, ModelsDev.Model>; modelApiIDs: Record<string, string> } {
    const models = { ...source.models }
    const modelApiIDs = Object.fromEntries(Object.entries(models).map(([modelID, model]) => [modelID, model.id]))
    for (const [modelID, raw] of Object.entries(configured?.models ?? {})) {
      const model = raw as Record<string, any>
      const explicitSourceID = typeof model.id === "string" ? model.id : undefined
      const sourceID = explicitSourceID ?? modelID
      const base = models[sourceID] ?? models[modelID] ?? fallbackModel(source, sourceID)
      models[modelID] = { ...(mergeDeep(base, model) as ModelsDev.Model), id: modelID }
      modelApiIDs[modelID] = explicitSourceID ?? base.id
    }
    for (const modelID of Object.keys(models)) {
      if (
        (configured?.whitelist && !configured.whitelist.includes(modelID)) ||
        configured?.blacklist?.includes(modelID)
      ) {
        delete models[modelID]
        delete modelApiIDs[modelID]
      }
    }
    return { models, modelApiIDs }
  }

  /**
   * The single composition path for a connection. Used by provider init,
   * getSDK option resolution, import probes and (via a serialized definition)
   * the agent worker — so all of them merge in the same order.
   */
  export async function composeProviderSpec(input: ComposeInput): Promise<ComposeResult> {
    const { connection, catalogs, auth } = input
    const { profile, configured } = connection

    const source = connection.catalogSourceID
      ? sourceCatalog(catalogs, connection.modelsDevProviderID)[connection.catalogSourceID]
      : undefined
    if (!source && connection.modelsDevProviderID) {
      return {
        ok: false,
        reason: "unknown_catalog_source",
        connectionID: connection.connectionID,
        catalogSourceID: connection.catalogSourceID,
      }
    }
    const env = connection.env
    const catalogSource = source
      ? {
          ...source,
          id: connection.connectionID,
          name: configured?.name ?? source.name,
          env,
          api: configured?.api ?? source.api,
          npm: configured?.npm ?? source.npm,
          models: configured?.npm
            ? Object.fromEntries(
                Object.entries(source.models).map(([modelID, model]) => [
                  modelID,
                  { ...model, provider: { ...(model.provider ?? {}), npm: configured.npm } },
                ]),
              )
            : source.models,
        }
      : undefined
    const emptySource: ModelsDev.Provider = {
      id: connection.connectionID,
      name: connection.connectionID,
      env: [],
      models: {},
    }
    const { models, modelApiIDs } = applyModelRules(catalogSource ?? emptySource, configured)

    const profileInput = { providerID: connection.connectionID, auth, provider: catalogSource }
    const resolvedAuth = (await profile?.resolveAuth?.(profileInput)) ?? auth
    const modelOptions = (await profile?.modelOptions?.({ ...profileInput, auth: resolvedAuth })) ?? {}
    const runtimeOptions = (await profile?.runtimeOptions?.({ ...profileInput, auth: resolvedAuth })) ?? {}
    const runtime = mergeDeep(modelOptions, runtimeOptions)
    const explicitOptions = mergeDeep(configured?.api ? { baseURL: configured.api } : {}, configured?.options ?? {})

    return {
      ok: true,
      spec: {
        providerID: connection.connectionID,
        profileID: profile?.id,
        catalogSource,
        models,
        modelApiIDs,
        options: mergeDeep(runtime, explicitOptions) as Record<string, unknown>,
        baseOptions: {} as Record<string, unknown>,
        explicitOptions: explicitOptions as Record<string, unknown>,
        env,
        api: configured?.api,
        npm: configured?.npm,
        baseURL: connection.baseURL,
      },
    }
  }

  /**
   * Per-connection state lifecycle: snapshot storage, eviction protection and
   * invalidation. The eviction protection is computed from the ACTIVE
   * connection set — not the canonical profile set — so low-activity
   * connections' live catalog snapshots are never collected as LRU garbage
   * while they remain registered (fixes the PR #990 review finding B1).
   */
  export class ConnectionStateManager {
    private readonly active = new Map<string, string>()
    private readonly snapshots = new Map<string, SnapshotRecord>()
    private readonly maxEntries: number

    constructor(maxEntries = 100) {
      this.maxEntries = maxEntries
    }

    register(connectionID: string, snapshotKey: string) {
      this.active.set(connectionID, snapshotKey)
      this.evict()
    }

    unregister(connectionID: string) {
      this.active.delete(connectionID)
      this.evict()
    }

    isActive(connectionID: string) {
      return this.active.has(connectionID)
    }

    activeConnections(): string[] {
      return [...this.active.keys()]
    }

    set(connectionID: string, key: string, snapshot: unknown, lastAttemptAt = Date.now()) {
      this.snapshots.set(key, { connectionID, lastAttemptAt, snapshot })
      this.evict()
    }

    get(key: string): unknown | undefined {
      return this.snapshots.get(key)?.snapshot
    }

    has(key: string) {
      return this.snapshots.has(key)
    }

    /** Current snapshot key protected for each active connection. */
    protectedKeys(): Set<string> {
      return new Set(this.active.values())
    }

    /** Evict unprotected LRU entries until under the cap. */
    evict(): string[] {
      const evicted: string[] = []
      const protectedKeys = this.protectedKeys()
      const removable = [...this.snapshots.entries()]
        .filter(([key]) => !protectedKeys.has(key))
        .sort(([, left], [, right]) => left.lastAttemptAt - right.lastAttemptAt)
      while (this.snapshots.size > this.maxEntries) {
        const entry = removable.shift()
        if (!entry) break
        this.snapshots.delete(entry[0])
        evicted.push(entry[0])
      }
      return evicted
    }

    invalidate(connectionID: string): string[] {
      const invalidated: string[] = []
      this.active.delete(connectionID)
      for (const [key, record] of this.snapshots) {
        if (record.connectionID !== connectionID) continue
        this.snapshots.delete(key)
        invalidated.push(key)
      }
      return invalidated
    }

    clear() {
      this.active.clear()
      this.snapshots.clear()
    }
  }

  interface SnapshotRecord {
    connectionID: string
    lastAttemptAt: number
    snapshot: unknown
  }
}
