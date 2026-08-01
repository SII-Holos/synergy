import { Log } from "@/util/log"
import { mergeDeep } from "remeda"
import type { Provider as ConfigProvider } from "../config/schema"
import type { Auth } from "./api-key"
import type { ModelsDev } from "./models"
import { ProviderProfile } from "./profile"

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

  /** Resolver input; `profile` remains internal until production consumers migrate. */
  export type ConfiguredProvider = Pick<
    ConfigProvider,
    "modelsDevProviderID" | "name" | "api" | "npm" | "env" | "options" | "models" | "whitelist" | "blacklist"
  > & { profile?: string }

  export type ConnectionConfig = { provider?: Record<string, ConfiguredProvider> }

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
    /** Derived base URL: options.baseURL ?? api ?? profile.baseURL. */
    baseURL: string | undefined
    /** Unified env rule: configured.env ?? profile.env. */
    env: string[]
    configured: ConfiguredProvider | undefined
  }

  export type ResolveResult =
    | { ok: true; connection: ConnectionDefinition }
    | { ok: false; reason: "unknown_profile"; connectionID: string; profileID?: string }

  export type ResolveAllResult =
    | { ok: true; connections: Record<string, ConnectionDefinition> }
    | { ok: false; failures: Array<Extract<ResolveResult, { ok: false }>> }

  /**
   * Resolve one connection ID against config. Explicit failures instead of
   * silent degradation: a configured `profile` that is not registered is an
   * `unknown_profile` result, never a bundled fallback.
   */
  export function resolveConnection(connectionID: string, config: ConnectionConfig | undefined): ResolveResult {
    const configured = config?.provider?.[connectionID]
    const explicitProfileID = configured?.profile
    const profile = explicitProfileID ? ProviderProfile.get(explicitProfileID) : ProviderProfile.get(connectionID)

    if (explicitProfileID && !profile) {
      log.warn("configured provider profile not found", { providerID: connectionID, profileID: explicitProfileID })
      return { ok: false, reason: "unknown_profile", connectionID, profileID: explicitProfileID }
    }

    const catalogSourceID = configured?.modelsDevProviderID ?? profile?.id ?? connectionID
    const env = configured?.env ?? profile?.env ?? []
    const baseURL =
      (typeof configured?.options?.baseURL === "string" ? configured.options.baseURL : undefined) ??
      configured?.api ??
      profile?.baseURL

    return {
      ok: true,
      connection: {
        connectionID,
        profile,
        isMapped: profile ? connectionID !== profile.id : false,
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
  export function resolveAllConnections(config: ConnectionConfig | undefined): ResolveAllResult {
    const connections: Record<string, ConnectionDefinition> = {}
    const failures: Array<Extract<ResolveResult, { ok: false }>> = []
    const connectionIDs = new Set([
      ...ProviderProfile.all().map((profile) => profile.id),
      ...Object.keys(config?.provider ?? {}),
    ])
    for (const connectionID of connectionIDs) {
      const resolved = resolveConnection(connectionID, config)
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
    /** Authoritative catalog (already merged remote/live projections). */
    catalog: Record<string, ModelsDev.Provider>
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
    const { connection, catalog, auth } = input
    const { profile, configured } = connection

    const source = connection.catalogSourceID ? catalog[connection.catalogSourceID] : undefined
    if (!source && connection.modelsDevProviderID) {
      return {
        ok: false,
        reason: "unknown_catalog_source",
        connectionID: connection.connectionID,
        catalogSourceID: connection.catalogSourceID,
      }
    }
    const env =
      configured?.env ??
      profile?.env ??
      (!connection.isMapped && !connection.modelsDevProviderID ? source?.env : undefined) ??
      []
    const catalogSource = source
      ? {
          ...source,
          id: connection.connectionID,
          name: configured?.name ?? source.name,
          env,
          api: configured?.api ?? source.api,
          npm: configured?.npm ?? source.npm,
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
