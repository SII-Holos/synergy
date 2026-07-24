import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { mergeDeep } from "remeda"
import z from "zod"
import { McpServerConfig } from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { ScopeContext } from "../scope/context"
import { Installation } from "../global/installation"
import { Global } from "../global"
import { withTimeout } from "../util/timeout"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { McpOAuthProvider } from "./oauth-provider"
import { PluginId } from "../plugin/ids.js"
import { PendingOAuth } from "./pending-oauth"
import { McpAuth } from "./auth"
import { ProcessInspection } from "../process/inspection"

// ---------------------------------------------------------------------------
// Bus events — defined here, re-exported by index.ts for back-compat
// ---------------------------------------------------------------------------

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  z.object({
    server: z.string(),
  }),
)

export const PromptsChanged = BusEvent.define(
  "mcp.prompts.changed",
  z.object({
    server: z.string(),
  }),
)

export const ResourcesChanged = BusEvent.define(
  "mcp.resources.changed",
  z.object({
    server: z.string(),
  }),
)

export const Ready = BusEvent.define("mcp.ready", z.object({}))

export const Failed = BusEvent.define(
  "mcp.failed",
  z.object({
    server: z.string(),
    error: z.string(),
  }),
)

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const Resource = z
  .object({
    name: z.string(),
    uri: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    client: z.string(),
  })
  .meta({ ref: "McpResource" })

// ---------------------------------------------------------------------------
// Transport re-export for auth flows
// ---------------------------------------------------------------------------

export type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport

// ---------------------------------------------------------------------------
// Internal state enum
// ---------------------------------------------------------------------------

const enum HS {
  Uninitialized = 0,
  Starting = 1,
  Connecting = 2,
  ListingTools = 3,
  Connected = 4,
  Reconnecting = 5,
  Failed = 6,
  Disabled = 7,
  NeedsAuth = 8,
  NeedsClientRegistration = 9,
  Stopping = 10,
}

// ---------------------------------------------------------------------------
// Public status type (mirrors the existing MCP.Status discriminated union)
// ---------------------------------------------------------------------------

export const Status = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("uninitialized") }).meta({ ref: "MCPStatusUninitialized" }),
    z.object({ status: z.literal("starting") }).meta({ ref: "MCPStatusStarting" }),
    z.object({ status: z.literal("connecting") }).meta({ ref: "MCPStatusConnecting" }),
    z.object({ status: z.literal("listing_tools") }).meta({ ref: "MCPStatusListingTools" }),
    z.object({ status: z.literal("connected") }).meta({ ref: "MCPStatusConnected" }),
    z
      .object({ status: z.literal("reconnecting"), attempt: z.number(), maxAttempts: z.number() })
      .meta({ ref: "MCPStatusReconnecting" }),
    z.object({ status: z.literal("failed"), error: z.string() }).meta({ ref: "MCPStatusFailed" }),
    z.object({ status: z.literal("disabled") }).meta({ ref: "MCPStatusDisabled" }),
    z.object({ status: z.literal("needs_auth") }).meta({ ref: "MCPStatusNeedsAuth" }),
    z
      .object({ status: z.literal("needs_client_registration"), error: z.string() })
      .meta({ ref: "MCPStatusNeedsClientRegistration" }),
    z.object({ status: z.literal("stopping") }).meta({ ref: "MCPStatusStopping" }),
  ])
  .meta({ ref: "MCPStatus" })
export type Status = z.infer<typeof Status>

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

type PromptInfo = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<Client["listResources"]>>["resources"][number]
export type PromptCache = Record<string, PromptInfo & { client: string }>
export type ResourceCache = Record<string, ResourceInfo & { client: string }>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = Log.create({ service: "mcp.supervisor" })
const DEFAULT_TIMEOUT = 30_000
const MAX_CONCURRENT_STARTS = 3

const SAFE_BASE_ENV_KEYS = new Set(["PATH", "HOME", "USER", "TMPDIR", "SHELL", "LANG", "XDG_CACHE_HOME"])

function buildLocalEnv(command: string, explicitEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_BASE_ENV_KEYS) {
    if (key in process.env && process.env[key] !== undefined) {
      env[key] = process.env[key]!
    }
  }
  if (command === "synergy") {
    env.BUN_BE_BUN = "1"
  }
  if (explicitEnv) {
    Object.assign(env, explicitEnv)
  }
  return env
}

const SECRET_ARG_PATTERNS = [
  /token/i,
  /api[_-]?key/i,
  /apikey/i,
  /key/i,
  /secret/i,
  /password/i,
  /bearer/i,
  /authorization/i,
]

function isSensitiveArg(arg: string): boolean {
  return SECRET_ARG_PATTERNS.some((p) => p.test(arg))
}

function redactCommand(command: string[]): string[] {
  return command.map((arg, i) => {
    if (i === 0) return arg
    const prev = command[i - 1]
    if (prev && prev.startsWith("-") && isSensitiveArg(prev.replace(/^--?/, ""))) {
      return "[redacted]"
    }
    return arg
  })
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.search) return url
    const params = new URLSearchParams(parsed.search)
    let changed = false
    for (const [key] of params) {
      if (isSensitiveArg(key)) {
        params.set(key, "[redacted]")
        changed = true
      }
    }
    if (!changed) return url
    parsed.search = params.toString()
    return parsed.toString()
  } catch {
    return url
  }
}

function localServerCwd(config: Extract<Config.Mcp, { type: "local" }>): string {
  if (config.cwd) return config.cwd
  const scope = ScopeContext.tryScope()
  if (scope?.type === "project") return scope.directory
  return Global.Path.home
}

async function closeFailedClient(client: Client, name: string, phase: string): Promise<void> {
  await client.close().catch((error) => {
    log.error("failed to close MCP client after failed startup", { name, phase, error })
  })
}

export async function connectClientOrCloseOnFailure(
  client: Pick<Client, "connect" | "close">,
  transport: Parameters<Client["connect"]>[0],
  connectTimeout: number | undefined,
  name: string,
  phase: string,
): Promise<void> {
  try {
    await withTimeout(client.connect(transport), connectTimeout)
  } catch (error) {
    await closeFailedClient(client as Client, name, phase)
    throw error
  }
}

export async function probeClientConnection(
  client: Pick<Client, "connect" | "close">,
  transport: Parameters<Client["connect"]>[0],
  name: string,
): Promise<void> {
  try {
    await client.connect(transport)
  } finally {
    await client.close().catch((error) => {
      log.error("failed to close MCP probe client", { name, error })
    })
  }
}

export const InvalidPluginServer = NamedError.create(
  "MCPInvalidPluginServer",
  z.object({
    pluginId: z.string(),
    contributionId: z.string(),
    issues: z.custom<z.core.$ZodIssue[]>(),
  }),
)

export type McpServerSource = "config" | "plugin" | "runtime"

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  )
}

function configFingerprint(config: Config.Mcp): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(stable(config))).digest("hex")
}

// ---------------------------------------------------------------------------
// McpHandle — per-server state
// ---------------------------------------------------------------------------

export interface McpHandle {
  name: string
  config: Config.Mcp
  source: McpServerSource
  pluginId?: string
  fingerprint: string
  identity: string
  state: HS
  client?: Client
  toolDefs: MCPToolDef[]
  prompts: PromptCache
  resources: ResourceCache
  retryCount: number
  generation: number
  lastError?: string
  startPromise?: Promise<void>
  localProcess?: {
    pid: number
    startedAt: number
    currentRssBytes?: number
    baselineRssBytes?: number
    peakRssBytes?: number
    sampledAt?: number
    stdioState: "open" | "closing" | "closed"
    closeTimedOut: boolean
    closeTimeoutMs: number
    descendantPipeGraceMs: number
  }
}

function newHandle(
  name: string,
  config: Config.Mcp,
  source: McpServerSource,
  identityGeneration: number,
  pluginId?: string,
): McpHandle {
  const fingerprint = configFingerprint(config)
  return {
    name,
    config,
    source,
    pluginId,
    fingerprint,
    identity: `${source}:${identityGeneration}:${fingerprint}`,
    state: HS.Uninitialized,
    toolDefs: [],
    prompts: {},
    resources: {},
    retryCount: 0,
    generation: 0,
  }
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------
export function mapStatus(handle: McpHandle): Status {
  switch (handle.state) {
    case HS.Uninitialized:
      return { status: "uninitialized" }
    case HS.Starting:
      return { status: "starting" }
    case HS.Connecting:
      return { status: "connecting" }
    case HS.ListingTools:
      return { status: "listing_tools" }
    case HS.Connected:
      return { status: "connected" }
    case HS.Reconnecting:
      return {
        status: "reconnecting",
        attempt: handle.retryCount,
        maxAttempts: handle.config.retry?.maxAttempts ?? 3,
      }
    case HS.Failed:
      return { status: "failed", error: handle.lastError ?? "unknown error" }
    case HS.Disabled:
      return { status: "disabled" }
    case HS.NeedsAuth:
      return { status: "needs_auth" }
    case HS.NeedsClientRegistration:
      return { status: "needs_client_registration", error: handle.lastError ?? "" }
    case HS.Stopping:
      return { status: "stopping" }
  }
}

// ---------------------------------------------------------------------------
// McpSupervisor — process-level singleton
// ---------------------------------------------------------------------------

class McpSupervisorImpl {
  private handles = new Map<string, McpHandle>()
  private lastRecovery:
    | {
        action: "close"
        reason: string
        at: number
        beforeBytes?: number
        afterBytes?: number
        reclaimedBytes?: number
        timedOut: boolean
      }
    | undefined
  private pendingStarts: McpHandle[] = []
  private activeStarts = 0
  private _started = false
  private initPromise?: Promise<void>
  private mutation = Promise.resolve()
  private identityGeneration = 0

  // ── Public ──────────────────────────────────────────────────────────

  get started(): boolean {
    return this._started
  }

  /** Initialize from config. Idempotent and non-blocking for MCP connections. */
  ensureStarted(): void {
    if (this._started) return
    this._started = true
    this.initPromise = this.initFromConfig().catch((error) => {
      log.error("failed to initialize MCP supervisor", { error })
    })
  }

  /** Wait until config has been loaded into the registry. Does not wait for MCP connections. */
  async ready(): Promise<void> {
    this.ensureStarted()
    await this.initPromise
  }

  /** Create or retrieve a dynamic runtime handle. Does not auto-start. */
  getOrCreate(name: string, config: Config.Mcp): McpHandle {
    const existing = this.handles.get(name)
    if (existing) return existing
    const handle = this.createHandle(name, config, "runtime")
    this.handles.set(name, handle)
    return handle
  }

  /** Get a handle by name. */
  get(name: string): McpHandle | undefined {
    return this.handles.get(name)
  }

  /** Get all handles. */
  getAll(): McpHandle[] {
    return [...this.handles.values()]
  }

  /** Add a dynamic runtime handle and schedule background connect when policy allows it. */
  add(name: string, config: Config.Mcp): McpHandle {
    const existing = this.handles.get(name)
    const handle =
      existing?.source === "runtime" && existing.fingerprint === configFingerprint(config)
        ? existing
        : this.createHandle(name, config, "runtime")
    if (handle !== existing) {
      this.handles.set(name, handle)
      if (existing) {
        this.invalidateHandle(existing)
        void this.disposeHandle(existing, "runtime replacement")
      }
    }
    this.applyStartupPolicy(handle)
    return handle
  }

  /**
   * Connect a handle and wait for the result.
   * Used by manual connect commands and OAuth finishAuth.
   */
  async connect(name: string, identity?: string): Promise<McpHandle> {
    const handle = this.handles.get(name)
    if (!handle || (identity && handle.identity !== identity)) {
      throw new Error(`MCP server not found: ${name}`)
    }
    handle.retryCount = 0
    await this.connectPipeline(handle)
    return handle
  }

  /** Disconnect a handle. */
  async disconnect(name: string): Promise<void> {
    const handle = this.handles.get(name)
    if (!handle) {
      await PendingOAuth.dispose(name, "disconnected")
      return
    }
    this.invalidateHandle(handle)
    await this.disposeHandle(handle, "disconnected")
    if (!this.isCurrent(handle)) return
    handle.retryCount = 0
    handle.state = HS.Disabled
    Bus.publish(ToolsChanged, { server: name })
  }

  /** Remove a handle entirely. */
  async remove(name: string): Promise<void> {
    await this.serializeMutation(async () => {
      const handle = this.handles.get(name)
      this.handles.delete(name)
      if (!handle) {
        await PendingOAuth.dispose(name, "removed")
        return
      }
      this.invalidateHandle(handle)
      await this.disposeHandle(handle, "removed")
      Bus.publish(ToolsChanged, { server: name })
      Bus.publish(PromptsChanged, { server: name })
      Bus.publish(ResourcesChanged, { server: name })
    })
  }

  /** Reset all handles and clear the registry. */
  async reset(): Promise<void> {
    log.info("resetting all MCP handles")
    const handles = [...this.handles.values()]
    this.handles.clear()
    this._started = false
    this.activeStarts = 0
    this.pendingStarts = []
    this.initPromise = undefined
    await PendingOAuth.disposeAll("supervisor reset")

    await Promise.all(handles.map((handle) => this.disposeHandle(handle, "supervisor reset")))

    log.info("MCP supervisor reset complete")
  }

  /** Restart: disconnect then reconnect, resetting retry count. */
  async restart(name: string): Promise<McpHandle> {
    const handle = this.handles.get(name)
    if (!handle) {
      throw new Error(`MCP server not found: ${name}`)
    }
    await this.disconnect(name)
    handle.retryCount = 0
    handle.lastError = undefined
    this.scheduleStart(handle)
    return handle
  }

  /** Refresh: re-list tools/prompts/resources for a connected handle. */
  async refresh(name: string): Promise<McpHandle> {
    const handle = this.handles.get(name)
    if (!handle) {
      throw new Error(`MCP server not found: ${name}`)
    }
    if (handle.state !== HS.Connected || !handle.client) {
      return handle
    }
    const client = handle.client
    const gen = handle.generation

    const timeout = handle.config.listTimeout ?? handle.config.timeout ?? DEFAULT_TIMEOUT
    const tools = await withTimeout(client.listTools(), timeout)
      .then((r) => r.tools)
      .catch((e) => {
        log.error("refresh: listTools failed", { name, error: e })
        return undefined
      })

    const prompts = await fetchPromptsForHandle(handle, client).catch((e) => {
      log.error("refresh: listPrompts failed", { name, error: e })
      return undefined
    })

    const resources = await fetchResourcesForHandle(handle, client).catch((e) => {
      log.error("refresh: listResources failed", { name, error: e })
      return undefined
    })

    if (this.isCurrent(handle, gen)) {
      if (tools) handle.toolDefs = tools
      if (prompts) handle.prompts = prompts
      if (resources) handle.resources = resources
      Bus.publish(ToolsChanged, { server: handle.name })
      Bus.publish(PromptsChanged, { server: handle.name })
      Bus.publish(ResourcesChanged, { server: handle.name })
    }
    return handle
  }

  /** Inspect: status + lightweight diagnostics (tool names, resources, prompts). */
  inspect(name: string):
    | {
        status: Status
        toolNames: string[]
        resourceNames: string[]
        promptNames: string[]
      }
    | undefined {
    const handle = this.handles.get(name)
    if (!handle) return undefined
    return {
      status: mapStatus(handle),
      toolNames: handle.toolDefs.map((t) => t.name),
      resourceNames: Object.values(handle.resources).map((r) => r.name),
      promptNames: Object.values(handle.prompts).map((p) => p.name),
    }
  }

  resourceStats() {
    const processes = [...this.handles.values()]
      .map((handle) => handle.localProcess)
      .filter((entry): entry is NonNullable<McpHandle["localProcess"]> => Boolean(entry))
    for (const entry of processes) {
      if (entry.stdioState === "closed" || !ProcessInspection.alive(entry.pid)) continue
      const rssBytes = ProcessInspection.rssBytes(entry.pid)
      if (rssBytes === undefined) continue
      entry.currentRssBytes = rssBytes
      entry.baselineRssBytes =
        entry.baselineRssBytes === undefined ? rssBytes : Math.min(entry.baselineRssBytes, rssBytes)
      entry.peakRssBytes = Math.max(entry.peakRssBytes ?? 0, rssBytes)
      entry.sampledAt = Date.now()
    }
    const active = processes.filter((entry) => entry.stdioState !== "closed")
    const measured = active.filter((entry) => entry.currentRssBytes !== undefined)
    return {
      processCount: active.length,
      measuredProcessCount: measured.length,
      currentBytes: measured.reduce((sum, entry) => sum + (entry.currentRssBytes ?? 0), 0),
      baselineBytes: measured.reduce((sum, entry) => sum + (entry.baselineRssBytes ?? 0), 0),
      peakBytes: measured.reduce((sum, entry) => sum + (entry.peakRssBytes ?? 0), 0),
      retainedBytes: measured.reduce(
        (sum, entry) =>
          sum + Math.max(0, (entry.currentRssBytes ?? 0) - (entry.baselineRssBytes ?? entry.currentRssBytes ?? 0)),
        0,
      ),
      stdio: {
        open: processes.filter((entry) => entry.stdioState === "open").length,
        closing: processes.filter((entry) => entry.stdioState === "closing").length,
        closed: processes.filter((entry) => entry.stdioState === "closed").length,
        timedOut: processes.filter((entry) => entry.closeTimedOut).length,
      },
      lastRecovery: this.lastRecovery,
    }
  }

  /** Test: validate presence and return status snapshot. */
  test(name: string): Status | undefined {
    const handle = this.handles.get(name)
    if (!handle) return undefined
    return mapStatus(handle)
  }

  /** Lookup a connected client by name (used by getPrompt / readResource). */
  getClient(name: string): Client | undefined {
    const handle = this.handles.get(name)
    if (!handle || handle.state !== HS.Connected || !handle.client) return undefined
    return handle.client
  }

  // ── Plugin MCP lifecycle ──────────────────────────────────────────

  async replacePluginServers(pluginId: string, declarations: Record<string, unknown>): Promise<void> {
    await this.replacePluginCandidates([{ pluginId, declarations }], false)
  }

  async replaceAllPluginServers(
    candidates: Array<{ pluginId: string; declarations: Record<string, unknown> }>,
  ): Promise<void> {
    await this.replacePluginCandidates(candidates, true)
  }

  private async replacePluginCandidates(
    candidates: Array<{ pluginId: string; declarations: Record<string, unknown> }>,
    replaceAll: boolean,
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const cfg = await Config.current()
      const staged = candidates.flatMap(({ pluginId, declarations }) =>
        this.stagePluginServers(pluginId, declarations, cfg),
      )
      const pluginIds = new Set(candidates.map((candidate) => candidate.pluginId))
      const replaced = [...this.handles.values()].filter(
        (handle) => handle.source === "plugin" && (replaceAll || (handle.pluginId && pluginIds.has(handle.pluginId))),
      )
      const changedNames = new Set([...replaced.map((handle) => handle.name), ...staged.map((handle) => handle.name)])

      for (const handle of replaced) {
        this.handles.delete(handle.name)
        this.invalidateHandle(handle)
      }
      for (const handle of staged) this.handles.set(handle.name, handle)

      await Promise.all(replaced.map((handle) => this.disposeHandle(handle, "plugin replacement")))
      for (const handle of staged) this.applyStartupPolicy(handle)
      await Promise.all([...changedNames].map((server) => Bus.publish(ToolsChanged, { server })))
    })
  }

  private stagePluginServers(pluginId: string, declarations: Record<string, unknown>, cfg: Config.Info): McpHandle[] {
    const userMcp = cfg.mcp ?? {}
    const defaults =
      typeof declarations.defaults === "object" && declarations.defaults !== null
        ? (declarations.defaults as Record<string, unknown>)
        : {}
    const staged: McpHandle[] = []

    for (const [serverKey, declaration] of Object.entries(declarations)) {
      if (serverKey === "defaults" || serverKey === "locked") continue
      const merged = mergeDeep(defaults, declaration as Record<string, unknown>) as Record<string, unknown>
      const parsed = McpServerConfig.safeParse(merged)
      if (!parsed.success) {
        throw new InvalidPluginServer({
          pluginId,
          contributionId: serverKey,
          issues: parsed.error.issues,
        })
      }
      const name = PluginId.mcpServerKey(pluginId, serverKey)
      if (userMcp[serverKey] !== undefined || userMcp[name] !== undefined) continue
      const config = Config.normalizeMcp(parsed.data, cfg.mcpDefaults, cfg.experimental?.mcp_timeout)
      staged.push(this.createHandle(name, config, "plugin", pluginId))
    }
    return staged
  }

  private serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const current = this.mutation.then(mutation, mutation)
    this.mutation = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }

  // ── Internal ────────────────────────────────────────────────────────

  private createHandle(name: string, config: Config.Mcp, source: McpServerSource, pluginId?: string): McpHandle {
    return newHandle(name, config, source, ++this.identityGeneration, pluginId)
  }

  private isCurrent(handle: McpHandle, generation?: number): boolean {
    return this.handles.get(handle.name) === handle && (generation === undefined || handle.generation === generation)
  }

  private invalidateHandle(handle: McpHandle): void {
    handle.generation++
    handle.state = HS.Stopping
    this.pendingStarts = this.pendingStarts.filter((pending) => pending !== handle)
  }

  private async disposeHandle(handle: McpHandle, reason: string): Promise<void> {
    const client = handle.client
    handle.client = undefined
    handle.toolDefs = []
    handle.prompts = {}
    handle.resources = {}
    await PendingOAuth.disposeIfIdentity(handle.name, handle.identity, reason)
    if (client) {
      const owned = handle.localProcess
      if (owned) owned.stdioState = "closing"
      const beforeBytes = owned?.currentRssBytes
      let timedOut = false
      await withTimeout(client.close(), owned?.closeTimeoutMs ?? 5_000, {
        message: `MCP stdio close timed out: ${handle.name}`,
      }).catch((error) => {
        timedOut = error instanceof Error && error.message.includes("timed out")
        log.error("failed to close MCP client", { name: handle.name, error })
      })
      if (owned) {
        owned.stdioState = "closed"
        owned.closeTimedOut = timedOut
        this.lastRecovery = {
          action: "close",
          reason,
          at: Date.now(),
          beforeBytes,
          afterBytes: timedOut ? undefined : 0,
          reclaimedBytes: timedOut ? undefined : beforeBytes,
          timedOut,
        }
      }
    }
  }

  private applyStartupPolicy(handle: McpHandle): void {
    if (handle.config.enabled === false) {
      handle.state = HS.Disabled
      return
    }
    if (handle.config.startup === "manual" || handle.config.startup === "lazy") {
      handle.state = HS.Uninitialized
      return
    }
    if (handle.state === HS.Uninitialized || handle.state === HS.Failed) this.scheduleStart(handle)
  }

  private async initFromConfig(): Promise<void> {
    const cfg = await Config.current()
    for (const [key, mcp] of Object.entries(cfg.mcp ?? {})) {
      if (typeof mcp !== "object" || mcp === null || !("type" in mcp)) {
        if (mcp?.enabled !== false) log.error("Ignoring MCP config entry without type", { key })
        continue
      }
      const config = Config.normalizeMcp(mcp as Config.Mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout)
      const handle = this.createHandle(key, config, "config")
      this.handles.set(key, handle)
      this.applyStartupPolicy(handle)
    }
    Bus.publish(Ready, {})
  }

  private scheduleStart(handle: McpHandle): void {
    if (!this.isCurrent(handle)) return
    if (handle.state === HS.Connected || handle.state === HS.Starting || handle.state === HS.Connecting) return
    if (this.pendingStarts.includes(handle)) return

    handle.state = HS.Starting
    this.pendingStarts.push(handle)
    this.drainStarts()
  }

  private drainStarts(): void {
    while (this.activeStarts < MAX_CONCURRENT_STARTS) {
      const handle = this.pendingStarts.shift()
      if (!handle) return
      if (handle.state !== HS.Starting) continue

      this.activeStarts++
      handle.startPromise = this.connectPipeline(handle).finally(() => {
        this.activeStarts--
        this.drainStarts()
      })
      void handle.startPromise
    }
  }

  private async connectPipeline(handle: McpHandle): Promise<void> {
    if (!this.isCurrent(handle)) return
    const gen = ++handle.generation
    handle.state = HS.Connecting
    const config = handle.config
    let client: Client | undefined
    await PendingOAuth.disposeIfIdentity(handle.name, handle.identity, "connection restarted")
    if (!this.isCurrent(handle, gen)) return

    if (config.type === "remote") {
      const oauthDisabled = config.oauth === false
      const oauthConfig = typeof config.oauth === "object" ? config.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          handle.name,
          config.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
          },
          {
            onRedirect: async (url) => {
              if (!this.isCurrent(handle, gen)) return
              log.info("oauth redirect requested", { key: handle.name, host: url.hostname })
            },
            isCurrent: () => this.isCurrent(handle, gen),
          },
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(config.url), {
            authProvider,
            requestInit: config.headers ? { headers: config.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(config.url), {
            authProvider,
            requestInit: config.headers ? { headers: config.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = config.connectTimeout ?? config.timeout ?? DEFAULT_TIMEOUT
      let lastError: Error | undefined

      for (const { name: transportName, transport } of transports) {
        const candidateClient = new Client({
          name: "synergy",
          version: Installation.VERSION,
        })
        try {
          await withTimeout(candidateClient.connect(transport), connectTimeout)
          if (!this.isCurrent(handle, gen)) {
            await candidateClient.close().catch(() => {})
            return
          }
          registerNotificationHandlers(handle, candidateClient, (generation) => this.isCurrent(handle, generation))
          client = candidateClient
          log.info("connected", { key: handle.name, transport: transportName })
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (!this.isCurrent(handle, gen)) {
            await closeFailedClient(candidateClient, handle.name, `connect:${transportName}:stale`)
            return
          }

          if (error instanceof UnauthorizedError) {
            log.info("mcp server requires authentication", { key: handle.name, transport: transportName })

            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              await closeFailedClient(candidateClient, handle.name, `connect:${transportName}:registration`)
              if (!this.isCurrent(handle, gen)) return
              handle.state = HS.NeedsClientRegistration
              handle.lastError =
                "Server does not support dynamic client registration. Please provide clientId in config."
              log.warn("mcp server requires pre-registered client", { key: handle.name, transport: transportName })
            } else {
              const authEntry = await McpAuth.get(handle.name)
              const codeVerifier = authEntry?.codeVerifier
              const oauthState = authEntry?.oauthState
              const registered = await PendingOAuth.register(
                handle.name,
                {
                  client: candidateClient,
                  transport,
                  identity: handle.identity,
                  onDispose: async () => {
                    await Promise.all([
                      codeVerifier === undefined
                        ? undefined
                        : McpAuth.clearCodeVerifier(handle.name, codeVerifier).catch(() => undefined),
                      oauthState === undefined
                        ? undefined
                        : McpAuth.clearOAuthState(handle.name, oauthState).catch(() => undefined),
                    ])
                  },
                },
                { isCurrent: () => this.isCurrent(handle, gen) },
              )
              if (!registered) return
              handle.state = HS.NeedsAuth
              log.warn("mcp server requires authentication", {
                key: handle.name,
                transport: transportName,
                command: `synergy mcp auth ${handle.name}`,
              })
            }
            return
          }

          await closeFailedClient(candidateClient, handle.name, `connect:${transportName}`)
          if (!this.isCurrent(handle, gen)) return
          log.debug("transport connection failed", {
            key: handle.name,
            transport: transportName,
            url: redactUrl(config.url),
            error: lastError.message,
          })
        }
      }
    }

    if (config.type === "local") {
      const [command, ...args] = config.command
      const cwd = localServerCwd(config)
      const transport = new StdioClientTransport({
        stderr: "ignore",
        command,
        args,
        cwd,
        env: buildLocalEnv(command, config.environment),
      })
      const connectTimeout = config.connectTimeout ?? config.timeout ?? DEFAULT_TIMEOUT
      const candidateClient = new Client({
        name: "synergy",
        version: Installation.VERSION,
      })
      try {
        await connectClientOrCloseOnFailure(candidateClient, transport, connectTimeout, handle.name, "connect:stdio")
        if (!this.isCurrent(handle, gen)) {
          await candidateClient.close().catch(() => {})
          return
        }
        registerNotificationHandlers(handle, candidateClient, (generation) => this.isCurrent(handle, generation))
        client = candidateClient
        const pid = transport.pid
        if (pid !== null) {
          handle.localProcess = {
            pid,
            startedAt: Date.now(),
            stdioState: "open",
            closeTimedOut: false,
            closeTimeoutMs: 5_000,
            descendantPipeGraceMs: 2_000,
          }
        }
      } catch (error) {
        if (!this.isCurrent(handle, gen)) return
        log.error("local mcp startup failed", {
          key: handle.name,
          command: redactCommand(config.command),
          cwd,
          error,
        })
        handle.lastError = error instanceof Error ? error.message : String(error)
      }
    }

    if (!client) {
      this.handleConnectFailure(handle, gen)
      return
    }

    handle.state = HS.ListingTools
    const listTimeout = config.listTimeout ?? config.timeout ?? DEFAULT_TIMEOUT
    const toolsResult = await withTimeout(client.listTools(), listTimeout).catch((error) => {
      log.error("failed to get tools from client", { key: handle.name, error })
      return undefined
    })

    if (!this.isCurrent(handle, gen)) {
      await client.close().catch(() => {})
      return
    }
    if (!toolsResult) {
      await client.close().catch((error) => {
        log.error("failed to close MCP client after listTools failure", { name: handle.name, error })
      })
      if (!this.isCurrent(handle, gen)) return
      handle.lastError = "Failed to get tools"
      this.handleConnectFailure(handle, gen)
      return
    }

    handle.client = client
    handle.toolDefs = toolsResult.tools
    handle.state = HS.Connected
    handle.retryCount = 0
    handle.lastError = undefined

    log.info("MCP server connected", { key: handle.name, toolCount: toolsResult.tools.length })
    Bus.publish(ToolsChanged, { server: handle.name })
    void prewarmDiscoveryCaches(handle, (generation) => this.isCurrent(handle, generation))
  }

  private handleConnectFailure(handle: McpHandle, generation: number): void {
    if (!this.isCurrent(handle, generation)) return
    handle.client = undefined
    handle.toolDefs = []

    const retry = handle.config.retry
    const maxAttempts = retry?.maxAttempts ?? 3
    handle.retryCount++

    if (handle.retryCount >= maxAttempts) {
      handle.state = HS.Failed
      log.warn("MCP server permanently failed", {
        name: handle.name,
        error: handle.lastError,
        attempts: handle.retryCount,
      })
      Bus.publish(Failed, { server: handle.name, error: handle.lastError ?? "unknown error" })
      return
    }

    const backoffMs = retry?.backoffMs ?? 1000
    const backoffMultiplier = retry?.backoffMultiplier ?? 2
    const delay = Math.min(backoffMs * Math.pow(backoffMultiplier, handle.retryCount - 1), 30_000)

    handle.state = HS.Reconnecting
    log.info("scheduling MCP reconnect", {
      name: handle.name,
      attempt: handle.retryCount,
      delay,
      error: handle.lastError,
    })

    setTimeout(() => {
      if (this.isCurrent(handle, generation) && handle.state === HS.Reconnecting) this.scheduleStart(handle)
    }, delay)
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const McpSupervisor = new McpSupervisorImpl()

// ---------------------------------------------------------------------------
// Notification handlers — self-contained per-handle callbacks
// ---------------------------------------------------------------------------

function registerNotificationHandlers(
  handle: McpHandle,
  client: Client,
  isCurrent: (generation: number) => boolean,
): void {
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    const generation = handle.generation
    if (!isCurrent(generation)) return
    log.info("tools list changed notification received", { server: handle.name })
    const toolsResult = await client.listTools().catch((error) => {
      log.error("failed to refresh tool defs from notification", { clientName: handle.name, error })
      return undefined
    })
    if (toolsResult && isCurrent(generation) && handle.state === HS.Connected) {
      handle.toolDefs = toolsResult.tools
      Bus.publish(ToolsChanged, { server: handle.name })
    }
  })

  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
    const generation = handle.generation
    if (!isCurrent(generation)) return
    log.info("prompts list changed notification received", { server: handle.name })
    const prompts = await fetchPromptsForHandle(handle, client).catch((error) => {
      log.error("failed to refresh prompts from notification", { clientName: handle.name, error })
      return undefined
    })
    if (prompts && isCurrent(generation) && handle.state === HS.Connected) {
      handle.prompts = prompts
      Bus.publish(PromptsChanged, { server: handle.name })
    }
  })

  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    const generation = handle.generation
    if (!isCurrent(generation)) return
    log.info("resources list changed notification received", { server: handle.name })
    const resources = await fetchResourcesForHandle(handle, client).catch((error) => {
      log.error("failed to refresh resources from notification", { clientName: handle.name, error })
      return undefined
    })
    if (resources && isCurrent(generation) && handle.state === HS.Connected) {
      handle.resources = resources
      Bus.publish(ResourcesChanged, { server: handle.name })
    }
  })
}

// ---------------------------------------------------------------------------
// Discovery cache helpers
// ---------------------------------------------------------------------------

async function fetchPromptsForHandle(handle: McpHandle, client: Client): Promise<PromptCache> {
  const timeout = handle.config.listTimeout ?? handle.config.timeout ?? DEFAULT_TIMEOUT
  const prompts = await withTimeout(client.listPrompts(), timeout).catch((e) => {
    log.error("failed to get prompts", { clientName: handle.name, error: e })
    return undefined
  })
  if (!prompts) return {}
  const result: PromptCache = {}
  for (const prompt of prompts.prompts) {
    const sanitizedClientName = handle.name.replace(/[^a-zA-Z0-9_-]/g, "_")
    const sanitizedPromptName = prompt.name.replace(/[^a-zA-Z0-9_-]/g, "_")
    const key = sanitizedClientName + ":" + sanitizedPromptName
    result[key] = { ...prompt, client: handle.name }
  }
  return result
}

async function fetchResourcesForHandle(handle: McpHandle, client: Client): Promise<ResourceCache> {
  const timeout = handle.config.listTimeout ?? handle.config.timeout ?? DEFAULT_TIMEOUT
  const resources = await withTimeout(client.listResources(), timeout).catch((e) => {
    log.error("failed to get resources", { clientName: handle.name, error: e })
    return undefined
  })
  if (!resources) return {}
  const result: ResourceCache = {}
  for (const resource of resources.resources) {
    const sanitizedClientName = handle.name.replace(/[^a-zA-Z0-9_-]/g, "_")
    const sanitizedResourceName = resource.name.replace(/[^a-zA-Z0-9_-]/g, "_")
    const key = sanitizedClientName + ":" + sanitizedResourceName
    result[key] = { ...resource, client: handle.name }
  }
  return result
}

async function prewarmDiscoveryCaches(handle: McpHandle, isCurrent: (generation: number) => boolean): Promise<void> {
  if (handle.state !== HS.Connected || !handle.client) return
  const generation = handle.generation
  const client = handle.client

  const [promptCache, resourceCache] = await Promise.all([
    fetchPromptsForHandle(handle, client).catch((error) => {
      log.warn("failed to prewarm prompts", { clientName: handle.name, error })
      return undefined
    }),
    fetchResourcesForHandle(handle, client).catch((error) => {
      log.warn("failed to prewarm resources", { clientName: handle.name, error })
      return undefined
    }),
  ])

  if (!isCurrent(generation) || handle.state !== HS.Connected) return
  if (promptCache) {
    handle.prompts = promptCache
    Bus.publish(PromptsChanged, { server: handle.name })
  }
  if (resourceCache) {
    handle.resources = resourceCache
    Bus.publish(ResourcesChanged, { server: handle.name })
  }
}
