import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { CallToolResultSchema, type Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { Installation } from "../global/installation"
import { withTimeout } from "@/util/timeout"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import open from "open"
import { McpSupervisor, mapStatus } from "./supervisor"
import type { PromptCache, ResourceCache } from "./supervisor"
import { ToolExposure } from "@/tool/exposure"
import { PendingOAuth } from "./pending-oauth"

// Re-export supervisor symbols so downstream imports from "@/mcp" still work.
// These go at module scope, not inside the namespace.
import {
  ToolsChanged as _ToolsChanged,
  PromptsChanged as _PromptsChanged,
  ResourcesChanged as _ResourcesChanged,
  Ready as _Ready,
  Failed as _Failed,
  Resource as _Resource,
  Status as _Status,
} from "./supervisor"

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const toolCallTimeouts = new Map<string, number | undefined>()

  // ── Public schemas/events (re-exposed via the MCP namespace) ────────
  // These are declared here to satisfy the public API surface; the actual
  // registrations live in supervisor.ts.

  export const ToolsChanged = _ToolsChanged
  export const PromptsChanged = _PromptsChanged
  export const ResourcesChanged = _ResourcesChanged
  export const Ready = _Ready
  // Bus event for supervisor failure notifications.
  export const FailedEvent = _Failed

  // Legacy NamedError used by cli/error.ts — keep the old MCP.Failed name.
  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )
  export const Resource = _Resource
  export type Resource = z.infer<typeof _Resource>

  export const Status = _Status
  export type Status = z.infer<typeof _Status>

  export interface Server {
    name: string
    config: Config.Mcp
    source: "config" | "plugin" | "runtime"
    status: Status
    identity: string
  }
  const DEFAULT_TIMEOUT = 30_000

  export interface ToolEntry {
    id: string
    serverName: string
    toolName: string
    tool: Tool
    inputSchema: JSONSchema7
  }

  async function resolveMcpTimeout(serverName?: string): Promise<number> {
    const server = serverName ? await resolveServer(serverName) : undefined
    if (server) return server.config.listTimeout ?? server.config.timeout ?? DEFAULT_TIMEOUT
    return (await Config.current()).experimental?.mcp_timeout ?? DEFAULT_TIMEOUT
  }

  async function convertMcpTool(
    mcpTool: MCPToolDef,
    client: Client,
    callTimeout: number | undefined,
  ): Promise<Pick<ToolEntry, "inputSchema" | "tool">> {
    const source = mcpTool.inputSchema
    const inputSchema: JSONSchema7 = {
      ...(source as JSONSchema7),
      type: "object",
      properties: (source.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    return {
      inputSchema,
      tool: dynamicTool({
        description: mcpTool.description ?? "",
        inputSchema: jsonSchema(inputSchema),
        execute: async (args: unknown) => {
          return client.callTool(
            {
              name: mcpTool.name,
              arguments: args as Record<string, unknown>,
            },
            CallToolResultSchema,
            {
              resetTimeoutOnProgress: true,
              timeout: callTimeout,
            },
          )
        },
      }),
    }
  }

  export function ensureStarted(): void {
    McpSupervisor.ensureStarted()
  }

  export function toolCallTimeout(toolName: string): number | undefined {
    return toolCallTimeouts.get(toolName)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  export async function stop() {
    await McpOAuthCallback.stop()
    await McpSupervisor.reset()
  }

  export async function reload() {
    log.info("reloading mcp state")
    await McpSupervisor.reset()
    McpSupervisor.ensureStarted()
    log.info("mcp state reloaded")
  }

  // ── Status / clients ───────────────────────────────────────────────

  export async function resolveServer(name: string): Promise<Server | undefined> {
    await McpSupervisor.ready()
    const cfg = await Config.current()
    const configured = cfg.mcp?.[name]
    if (configured && typeof configured === "object" && "type" in configured && configured.enabled !== false) {
      const handle = McpSupervisor.get(name)
      if (!handle || handle.source !== "config") return undefined
      return {
        name,
        config: Config.normalizeMcp(configured as Config.Mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout),
        source: "config",
        status: mapStatus(handle),
        identity: handle.identity,
      }
    }

    const handle = McpSupervisor.get(name)
    if (!handle || handle.config.enabled === false || handle.source === "config") return undefined
    return {
      name: handle.name,
      config: handle.config,
      source: handle.source,
      status: mapStatus(handle),
      identity: handle.identity,
    }
  }

  export async function listServers(): Promise<Server[]> {
    await McpSupervisor.ready()
    const cfg = await Config.current()
    const servers = new Map<string, Server>()

    for (const [name, configured] of Object.entries(cfg.mcp ?? {})) {
      if (!configured || typeof configured !== "object" || !("type" in configured) || configured.enabled === false)
        continue
      const handle = McpSupervisor.get(name)
      if (!handle || handle.source !== "config") continue
      servers.set(name, {
        name,
        config: Config.normalizeMcp(configured as Config.Mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout),
        source: "config",
        status: mapStatus(handle),
        identity: handle.identity,
      })
    }

    for (const handle of McpSupervisor.getAll()) {
      if (servers.has(handle.name) || handle.source === "config" || handle.config.enabled === false) continue
      servers.set(handle.name, {
        name: handle.name,
        config: handle.config,
        source: handle.source,
        status: mapStatus(handle),
        identity: handle.identity,
      })
    }
    return [...servers.values()]
  }

  export async function status(): Promise<Record<string, Status>> {
    const cfg = await Config.current()
    const statuses = Object.fromEntries((await listServers()).map((server) => [server.name, server.status]))
    for (const [name, configured] of Object.entries(cfg.mcp ?? {})) {
      if (configured?.enabled === false) statuses[name] = { status: "disabled" }
    }
    return statuses
  }

  export async function clients(): Promise<Record<string, Client>> {
    await McpSupervisor.ready()
    const result: Record<string, Client> = {}
    for (const handle of McpSupervisor.getAll()) {
      if (handle.client) result[handle.name] = handle.client
    }
    return result
  }

  export async function connect(name: string) {
    ensureStarted()
    const server = await resolveServer(name)
    if (!server) {
      log.error("MCP server not found", { name })
      return
    }
    const handle = McpSupervisor.get(name)
    if (!handle || handle.identity !== server.identity) return
    handle.retryCount = 0
    await McpSupervisor.connect(name, server.identity)
  }

  export async function disconnect(name: string) {
    ensureStarted()
    await McpSupervisor.disconnect(name)
  }

  export async function add(name: string, mcp: Config.Mcp) {
    ensureStarted()
    const cfg = await Config.current()
    const server = Config.normalizeMcp(mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout)
    const handle = McpSupervisor.add(name, server)
    return { status: mapStatus(handle) }
  }

  // ── Supervisor actions ─────────────────────────────────────────────

  export async function restart(name: string): Promise<Status> {
    ensureStarted()
    const handle = await McpSupervisor.restart(name)
    return mapStatus(handle)
  }

  export async function refresh(name: string): Promise<Status> {
    ensureStarted()
    const handle = await McpSupervisor.refresh(name)
    return mapStatus(handle)
  }

  export async function inspect(name: string): Promise<{
    status: Status
    toolNames: string[]
    resourceNames: string[]
    promptNames: string[]
  } | null> {
    await McpSupervisor.ready()
    const result = McpSupervisor.inspect(name)
    if (!result) return null
    return result
  }

  export async function test(name: string): Promise<Status | null> {
    await McpSupervisor.ready()
    const result = McpSupervisor.test(name)
    if (!result) return null
    return result
  }

  // ── Non-blocking snapshots ─────────────────────────────────────────

  export async function toolEntries(): Promise<ToolEntry[]> {
    await McpSupervisor.ready()
    const result: ToolEntry[] = []
    toolCallTimeouts.clear()
    const callTimeout = (await Config.current()).experimental?.mcp_timeout

    for (const handle of McpSupervisor.getAll()) {
      if (mapStatus(handle).status !== "connected") continue
      if (!handle.client || handle.toolDefs.length === 0) continue

      for (const mcpTool of handle.toolDefs) {
        const toolName = ToolExposure.mcpToolID(handle.name, mcpTool.name)
        const effectiveCallTimeout = handle.config.callTimeout ?? callTimeout
        toolCallTimeouts.set(toolName, effectiveCallTimeout)
        const converted = await convertMcpTool(mcpTool, handle.client, effectiveCallTimeout)
        result.push({
          id: toolName,
          serverName: handle.name,
          toolName: mcpTool.name,
          ...converted,
        })
      }
    }

    return result
  }

  export async function tools(): Promise<Record<string, Tool>> {
    const result: Record<string, Tool> = {}
    for (const entry of await toolEntries()) {
      result[entry.id] = entry.tool
    }
    return result
  }

  export async function prompts(): Promise<PromptCache> {
    ensureStarted()
    const result: PromptCache = {}
    for (const handle of McpSupervisor.getAll()) {
      if (mapStatus(handle).status !== "connected") continue
      Object.assign(result, handle.prompts)
    }
    return result
  }

  export async function resources(): Promise<ResourceCache> {
    ensureStarted()
    const result: ResourceCache = {}
    for (const handle of McpSupervisor.getAll()) {
      if (mapStatus(handle).status !== "connected") continue
      Object.assign(result, handle.resources)
    }
    return result
  }

  export async function getPrompt(clientName: string, name: string, args?: Record<string, string>) {
    ensureStarted()
    const client = McpSupervisor.getClient(clientName)
    if (!client) {
      log.warn("client not found for prompt", { clientName })
      return undefined
    }
    const timeout = await resolveMcpTimeout(clientName)
    return withTimeout(client.getPrompt({ name, arguments: args }), timeout).catch((e) => {
      log.error("failed to get prompt from MCP server", {
        clientName,
        promptName: name,
        error: e instanceof Error ? e.message : String(e),
      })
      return undefined
    })
  }

  export async function readResource(clientName: string, resourceUri: string) {
    ensureStarted()
    const client = McpSupervisor.getClient(clientName)
    if (!client) {
      log.warn("client not found for resource", { clientName })
      return undefined
    }
    const timeout = await resolveMcpTimeout(clientName)
    return withTimeout(client.readResource({ uri: resourceUri }), timeout).catch((e) => {
      log.error("failed to read resource from MCP server", {
        clientName,
        resourceUri,
        error: e instanceof Error ? e.message : String(e),
      })
      return undefined
    })
  }

  // ── OAuth helpers ──────────────────────────────────────────────────

  async function clearPendingOAuthState(
    mcpName: string,
    expected?: { codeVerifier?: string; oauthState?: string },
  ): Promise<void> {
    McpOAuthCallback.cancelPending(mcpName, expected?.oauthState)
    if (!expected) {
      await Promise.all([
        McpAuth.clearCodeVerifier(mcpName).catch(() => undefined),
        McpAuth.clearOAuthState(mcpName).catch(() => undefined),
      ])
      return
    }
    await Promise.all([
      expected.codeVerifier === undefined
        ? undefined
        : McpAuth.clearCodeVerifier(mcpName, expected.codeVerifier).catch(() => undefined),
      expected.oauthState === undefined
        ? undefined
        : McpAuth.clearOAuthState(mcpName, expected.oauthState).catch(() => undefined),
    ])
  }

  export async function startAuth(mcpName: string): Promise<{ authorizationUrl: string }> {
    ensureStarted()
    const server = await resolveServer(mcpName)
    if (!server) throw new Error(`MCP server not found: ${mcpName}`)
    const mcpConfig = server.config
    if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
    if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)

    await PendingOAuth.dispose(mcpName, "OAuth restarted")
    await McpOAuthCallback.ensureRunning()

    const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const isCurrent = () => McpSupervisor.get(mcpName)?.identity === server.identity
    await McpAuth.updateOAuthState(mcpName, oauthState, { isCurrent })

    const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
    let capturedUrl: URL | undefined
    const authProvider = new McpOAuthProvider(
      mcpName,
      mcpConfig.url,
      {
        clientId: oauthConfig?.clientId,
        clientSecret: oauthConfig?.clientSecret,
        scope: oauthConfig?.scope,
      },
      {
        onRedirect: async (url) => {
          capturedUrl = url
        },
        isCurrent,
      },
    )

    const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), { authProvider })
    const client = new Client({ name: "synergy", version: Installation.VERSION })

    try {
      const connectTimeout = await resolveMcpTimeout(mcpName)
      await withTimeout(client.connect(transport), connectTimeout)
      if (McpSupervisor.get(mcpName)?.identity !== server.identity) {
        throw new Error("MCP server changed while OAuth was in progress; restart authentication")
      }
      await client.close().catch((closeError) => {
        log.warn("failed to close MCP client after OAuth probe", { mcpName, closeError })
      })
      const codeVerifier = (await McpAuth.get(mcpName))?.codeVerifier
      await clearPendingOAuthState(mcpName, { codeVerifier, oauthState })
      return { authorizationUrl: "" }
    } catch (error) {
      if (error instanceof UnauthorizedError && capturedUrl) {
        const codeVerifier = (await McpAuth.get(mcpName))?.codeVerifier
        const registered = await PendingOAuth.register(
          mcpName,
          {
            client,
            transport,
            identity: server.identity,
            onDispose: () => clearPendingOAuthState(mcpName, { codeVerifier, oauthState }),
          },
          { isCurrent },
        )
        if (!registered) throw new Error("MCP server changed while OAuth was in progress; restart authentication")
        return { authorizationUrl: capturedUrl.toString() }
      }
      await client.close().catch((closeError) => {
        log.warn("failed to close MCP client after OAuth probe", { mcpName, closeError })
      })
      const codeVerifier = (await McpAuth.get(mcpName))?.codeVerifier
      await clearPendingOAuthState(mcpName, { codeVerifier, oauthState })
      throw error
    }
  }

  export async function authenticate(mcpName: string): Promise<Status> {
    ensureStarted()
    const { authorizationUrl } = await startAuth(mcpName)
    if (!authorizationUrl) {
      return status().then((s) => s[mcpName] ?? { status: "connected" })
    }
    const pending = PendingOAuth.get(mcpName)
    if (!pending) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

    try {
      const oauthState = await McpAuth.getOAuthState(mcpName)
      if (!oauthState) throw new Error("OAuth state not found - this should not happen")

      log.info("opening browser for oauth", { mcpName, host: new URL(authorizationUrl).hostname })
      await open(authorizationUrl)

      const code = await McpOAuthCallback.waitForCallback(oauthState, mcpName)
      const storedState = await McpAuth.getOAuthState(mcpName)
      if (storedState !== oauthState) {
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      return await finishAuth(mcpName, code)
    } finally {
      await PendingOAuth.disposeIfCurrent(mcpName, pending, "OAuth interaction ended")
    }
  }

  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    ensureStarted()
    const pending = PendingOAuth.get(mcpName)
    if (!pending) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

    try {
      await pending.transport.finishAuth(authorizationCode)
      const handle = McpSupervisor.get(mcpName)
      if (!handle || handle.identity !== pending.identity || handle.config.enabled === false) {
        await PendingOAuth.disposeIfCurrent(mcpName, pending, "stale OAuth owner")
        return {
          status: "failed",
          error: "MCP server changed while OAuth was in progress; restart authentication",
        }
      }

      await PendingOAuth.disposeIfCurrent(mcpName, pending, "OAuth completed")
      const connected = await McpSupervisor.connect(mcpName, pending.identity)
      if (McpSupervisor.get(mcpName) !== connected || connected.identity !== pending.identity) {
        return {
          status: "failed",
          error: "MCP server changed while OAuth was in progress; restart authentication",
        }
      }
      return mapStatus(connected)
    } catch (error) {
      await PendingOAuth.disposeIfCurrent(mcpName, pending, "OAuth failed")
      const handle = McpSupervisor.get(mcpName)
      if (handle && handle.identity !== pending.identity) {
        return {
          status: "failed",
          error: "MCP server changed while OAuth was in progress; restart authentication",
        }
      }
      log.error("failed to finish oauth", { mcpName, error })
      return { status: "failed", error: error instanceof Error ? error.message : String(error) }
    }
  }

  export async function removeAuth(mcpName: string): Promise<void> {
    await PendingOAuth.dispose(mcpName, "OAuth removed")
    await clearPendingOAuthState(mcpName)
    await McpAuth.remove(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const server = await resolveServer(mcpName)
    return server?.config.type === "remote" && server.config.oauth !== false
  }

  export async function hasStoredTokens(mcpName: string): Promise<boolean> {
    const entry = await McpAuth.get(mcpName)
    return !!entry?.tokens
  }

  export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

  export async function getAuthStatus(mcpName: string): Promise<AuthStatus> {
    const hasTokens = await hasStoredTokens(mcpName)
    if (!hasTokens) return "not_authenticated"
    const expired = await McpAuth.isTokenExpired(mcpName)
    return expired ? "expired" : "authenticated"
  }
}
