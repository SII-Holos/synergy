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
import { Config } from "../config/config"
import { Log } from "../util/log"
import { Instance } from "../scope/instance"
import { Installation } from "../global/installation"
import { withTimeout } from "../util/timeout"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { McpOAuthProvider } from "./oauth-provider"

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

export const RetryConfig = z
  .object({
    maxRetries: z.number().int().min(0).max(10).default(3),
    baseDelayMs: z.number().int().min(100).max(60_000).default(1000),
    maxDelayMs: z.number().int().min(1000).max(300_000).default(30_000),
    backoffMultiplier: z.number().min(1).max(10).default(2),
  })
  .meta({ ref: "McpRetryConfig" })
export type RetryConfig = z.infer<typeof RetryConfig>

export const CircuitBreakerConfig = z
  .object({
    failureThreshold: z.number().int().min(1).max(20).default(5),
    recoveryTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    halfOpenMaxRequests: z.number().int().min(1).max(10).default(1),
  })
  .meta({ ref: "McpCircuitBreakerConfig" })
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfig>

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

function isServerDeclaration(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "type" in value
}

// ---------------------------------------------------------------------------
// McpHandle — per-server state
// ---------------------------------------------------------------------------

export interface McpHandle {
  name: string
  config: Config.Mcp
  state: HS
  client?: Client
  toolDefs: MCPToolDef[]
  prompts: PromptCache
  resources: ResourceCache
  retryCount: number
  generation: number
  lastError?: string
  startPromise?: Promise<void>
}

function newHandle(name: string, config: Config.Mcp): McpHandle {
  return {
    name,
    config,
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
// Pending OAuth transports (shared with index.ts for auth flows)
// ---------------------------------------------------------------------------

export const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// ---------------------------------------------------------------------------
// McpSupervisor — process-level singleton
// ---------------------------------------------------------------------------

class McpSupervisorImpl {
  private handles = new Map<string, McpHandle>()
  private pendingStarts: McpHandle[] = []
  private activeStarts = 0
  private _started = false
  private initPromise?: Promise<void>

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

  /** Create or retrieve a handle. Does not auto-start. */
  getOrCreate(name: string, config: Config.Mcp): McpHandle {
    const existing = this.handles.get(name)
    if (existing) return existing
    const handle = newHandle(name, config)
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

  /** Add a handle and schedule background connect when policy allows it. Returns the handle. */
  add(name: string, config: Config.Mcp): McpHandle {
    const handle = this.getOrCreate(name, config)
    handle.config = config
    if (config.enabled === false) {
      handle.state = HS.Disabled
      return handle
    }
    if (config.startup === "manual" || config.startup === "lazy") {
      handle.state = HS.Uninitialized
      return handle
    }
    if (handle.state === HS.Uninitialized || handle.state === HS.Failed) {
      this.scheduleStart(handle)
    }
    return handle
  }

  /**
   * Connect a handle and wait for the result.
   * Used by manual connect commands and OAuth finishAuth.
   */
  async connect(name: string): Promise<McpHandle> {
    const handle = this.handles.get(name)
    if (!handle) {
      throw new Error(`MCP server not found: ${name}`)
    }
    handle.retryCount = 0
    await this.connectPipeline(handle)
    return handle
  }

  /** Disconnect a handle. */
  async disconnect(name: string): Promise<void> {
    const handle = this.handles.get(name)
    if (!handle) return
    handle.state = HS.Stopping
    handle.generation++
    if (handle.client) {
      await handle.client.close().catch((error) => {
        log.error("failed to close MCP client", { name, error })
      })
      handle.client = undefined
    }
    handle.toolDefs = []
    handle.prompts = {}
    handle.resources = {}
    handle.retryCount = 0
    handle.state = HS.Disabled
    Bus.publish(ToolsChanged, { server: name })
  }

  /** Remove a handle entirely. */
  remove(name: string): void {
    void this.disconnect(name)
    this.handles.delete(name)
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
    pendingOAuthTransports.clear()

    await Promise.all(
      handles.map((h) => {
        if (h.client) {
          return h.client.close().catch((error) => {
            log.error("failed to close MCP client during reset", { name: h.name, error })
          })
        }
      }),
    )

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

    if (handle.generation === gen) {
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

  /**
   * Register all MCP server declarations from a plugin manifest.
   *
   * - Skips non-server entries (defaults, locked).
   * - Skips server keys that are already defined in user config (bare-key shadow).
   * - Deep-merges manifest `defaults` into each server declaration.
   * - Normalizes each declaration through Config.normalizeMcp (applying
   *   user mcpDefaults + experimental.mcp_timeout).
   * - Registers using the namespaced key `{pluginId}::{serverKey}`.
   *
   * This method is intentionally async (reads Config) but does NOT call
   * ensureStarted(). Plugin registrations are fire-and-forget — the
   * supervisor handles scheduling independently.
   */
  async registerPluginServers(pluginId: string, manifestMcp: Record<string, unknown>): Promise<void> {
    const cfg = await Config.get()
    const userMcp = cfg.mcp ?? {}
    const defaults =
      typeof manifestMcp.defaults === "object" && manifestMcp.defaults !== null
        ? (manifestMcp.defaults as Record<string, unknown>)
        : {}

    for (const [serverKey, declaration] of Object.entries(manifestMcp)) {
      // Skip metadata fields
      if (serverKey === "defaults" || serverKey === "locked") continue
      if (!isServerDeclaration(declaration)) continue

      // Bare-key shadow: user config wins
      if (userMcp[serverKey] !== undefined) {
        log.info("plugin MCP skipped (user config shadow)", { pluginId, serverKey })
        continue
      }

      const scopedKey = `${pluginId}::${serverKey}`

      // Skip if already registered (e.g. from a prior init/reload cycle)
      if (this.get(scopedKey)) {
        log.info("plugin MCP skipped (already registered)", { pluginId, serverKey })
        continue
      }

      const merged = mergeDeep(defaults, declaration as Record<string, unknown>) as Record<string, unknown>

      // Normalize through Config's standard MCP pipeline
      const normalized = Config.normalizeMcp(merged as Config.Mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout)

      this.add(scopedKey, normalized)
      log.info("plugin MCP registered", { pluginId, serverKey, scopedKey, startup: normalized.startup })
    }
  }

  /**
   * Unregister all MCP servers contributed by a plugin.
   * Disconnects and removes every handle whose name starts with `{pluginId}::`.
   */
  async unregisterPluginServers(pluginId: string): Promise<void> {
    const prefix = `${pluginId}::`
    const handles = this.getAll().filter((h) => h.name.startsWith(prefix))
    await Promise.all(handles.map((h) => this.disconnect(h.name)))
    for (const h of handles) {
      this.handles.delete(h.name)
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private async initFromConfig(): Promise<void> {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}

    for (const [key, mcp] of Object.entries(config)) {
      if (typeof mcp !== "object" || mcp === null || !("type" in mcp)) {
        log.error("Ignoring MCP config entry without type", { key })
        continue
      }

      const server = Config.normalizeMcp(mcp as Config.Mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout)
      const handle = this.getOrCreate(key, server)

      if (server.enabled === false) {
        handle.state = HS.Disabled
        continue
      }
      if (server.startup === "manual" || server.startup === "lazy") {
        handle.state = HS.Uninitialized
        continue
      }

      this.scheduleStart(handle)
    }

    Bus.publish(Ready, {})
  }

  private scheduleStart(handle: McpHandle): void {
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
    const gen = ++handle.generation
    handle.state = HS.Connecting
    const config = handle.config
    let client: Client | undefined

    // --- Transport setup ---
    if (config.type === "remote") {
      // OAuth is enabled by default for remote servers
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
              log.info("oauth redirect requested", { key: handle.name, host: url.hostname })
            },
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

      for (const { name: tname, transport } of transports) {
        try {
          const c = new Client({
            name: "synergy",
            version: Installation.VERSION,
          })
          await withTimeout(c.connect(transport), connectTimeout)
          registerNotificationHandlers(handle, c)
          client = c
          log.info("connected", { key: handle.name, transport: tname })
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          if (error instanceof UnauthorizedError) {
            log.info("mcp server requires authentication", { key: handle.name, transport: tname })

            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              handle.state = HS.NeedsClientRegistration
              handle.lastError =
                "Server does not support dynamic client registration. Please provide clientId in config."
              log.warn("mcp server requires pre-registered client", { key: handle.name, transport: tname })
            } else {
              pendingOAuthTransports.set(handle.name, transport)
              handle.state = HS.NeedsAuth
              log.warn("mcp server requires authentication", {
                key: handle.name,
                transport: tname,
                command: `synergy mcp auth ${handle.name}`,
              })
            }
            return
          }

          log.debug("transport connection failed", {
            key: handle.name,
            transport: tname,
            url: redactUrl(config.url),
            error: lastError.message,
          })
        }
      }
    }

    if (config.type === "local") {
      const [cmd, ...args] = config.command
      const cwd = Instance.directory
      const transport = new StdioClientTransport({
        stderr: "ignore",
        command: cmd,
        args,
        cwd,
        env: buildLocalEnv(cmd, config.environment),
      })
      const connectTimeout = config.connectTimeout ?? config.timeout ?? DEFAULT_TIMEOUT
      try {
        const c = new Client({
          name: "synergy",
          version: Installation.VERSION,
        })
        await withTimeout(c.connect(transport), connectTimeout)
        registerNotificationHandlers(handle, c)
        client = c
      } catch (error) {
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
      await this.handleConnectFailure(handle)
      return
    }

    // --- listTools ---
    handle.state = HS.ListingTools
    const listTimeout = config.listTimeout ?? config.timeout ?? DEFAULT_TIMEOUT
    const toolsResult = await withTimeout(client.listTools(), listTimeout).catch((err) => {
      log.error("failed to get tools from client", { key: handle.name, error: err })
      return undefined
    })

    if (!toolsResult) {
      await client.close().catch((error) => {
        log.error("failed to close MCP client after listTools failure", { name: handle.name, error })
      })
      handle.lastError = "Failed to get tools"
      await this.handleConnectFailure(handle)
      return
    }

    // Check generation: if handle was reset during listTools, discard
    if (handle.generation !== gen) {
      await client.close().catch(() => {})
      return
    }

    handle.client = client
    handle.toolDefs = toolsResult.tools
    handle.state = HS.Connected
    handle.retryCount = 0
    handle.lastError = undefined

    log.info("MCP server connected", { key: handle.name, toolCount: toolsResult.tools.length })
    Bus.publish(ToolsChanged, { server: handle.name })

    // Prewarm discovery caches (fire and forget)
    void prewarmDiscoveryCaches(handle)
  }

  private async handleConnectFailure(handle: McpHandle): Promise<void> {
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
      if (handle.state === HS.Reconnecting) {
        this.scheduleStart(handle)
      }
    }, delay)
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const McpSupervisor = new McpSupervisorImpl()

// ---------------------------------------------------------------------------
// Notification handlers — operate on handle, not Instance.state
// ---------------------------------------------------------------------------

function registerNotificationHandlers(handle: McpHandle, client: Client): void {
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    log.info("tools list changed notification received", { server: handle.name })
    const gen = handle.generation
    const toolsResult = await client.listTools().catch((e) => {
      log.error("failed to refresh tool defs from notification", { clientName: handle.name, error: e })
      return undefined
    })
    if (toolsResult && handle.generation === gen && handle.state === HS.Connected) {
      handle.toolDefs = toolsResult.tools
      Bus.publish(ToolsChanged, { server: handle.name })
    }
  })

  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
    log.info("prompts list changed notification received", { server: handle.name })
    const gen = handle.generation
    const prompts = await fetchPromptsForHandle(handle, client).catch((e) => {
      log.error("failed to refresh prompts from notification", { clientName: handle.name, error: e })
      return undefined
    })
    if (prompts && handle.generation === gen && handle.state === HS.Connected) {
      handle.prompts = prompts
      Bus.publish(PromptsChanged, { server: handle.name })
    }
  })

  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    log.info("resources list changed notification received", { server: handle.name })
    const gen = handle.generation
    const resources = await fetchResourcesForHandle(handle, client).catch((e) => {
      log.error("failed to refresh resources from notification", { clientName: handle.name, error: e })
      return undefined
    })
    if (resources && handle.generation === gen && handle.state === HS.Connected) {
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

async function prewarmDiscoveryCaches(handle: McpHandle): Promise<void> {
  if (handle.state !== HS.Connected || !handle.client) return
  const gen = handle.generation
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

  if (handle.generation !== gen || handle.state !== HS.Connected) return
  if (promptCache) {
    handle.prompts = promptCache
    Bus.publish(PromptsChanged, { server: handle.name })
  }
  if (resourceCache) {
    handle.resources = resourceCache
    Bus.publish(ResourcesChanged, { server: handle.name })
  }
}
