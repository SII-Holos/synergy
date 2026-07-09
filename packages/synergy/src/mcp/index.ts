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
import { McpSupervisor, mapStatus, pendingOAuthTransports } from "./supervisor"
import type { McpHandle, PromptCache, ResourceCache } from "./supervisor"
import { ToolExposure } from "@/tool/exposure"

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

  const DEFAULT_TIMEOUT = 30_000

  export interface ToolEntry {
    id: string
    serverName: string
    toolName: string
    tool: Tool
  }

  async function resolveMcpTimeout(serverName?: string): Promise<number> {
    const cfg = await Config.current()
    const perServer = serverName ? (cfg.mcp?.[serverName] as Config.Mcp | undefined)?.timeout : undefined
    return perServer ?? cfg.experimental?.mcp_timeout ?? DEFAULT_TIMEOUT
  }

  async function resolveCallTimeout(serverName: string): Promise<number | undefined> {
    const cfg = await Config.current()
    const server = cfg.mcp?.[serverName] as Config.Mcp | undefined
    if (!server || typeof server !== "object") return undefined
    return server.callTimeout ?? cfg.experimental?.mcp_timeout
  }

  async function convertMcpTool(mcpTool: MCPToolDef, client: Client, callTimeout: number | undefined): Promise<Tool> {
    const inputSchema = mcpTool.inputSchema
    const schema: JSONSchema7 = {
      ...(inputSchema as JSONSchema7),
      type: "object",
      properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    return dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema(schema),
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
    })
  }

  export function ensureStarted(): void {
    McpSupervisor.ensureStarted()
  }

  export function toolCallTimeout(toolName: string): number | undefined {
    return toolCallTimeouts.get(toolName)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  export async function reload() {
    log.info("reloading mcp state")
    await McpSupervisor.reset()
    McpSupervisor.ensureStarted()
    log.info("mcp state reloaded")
  }

  // ── Status / clients ───────────────────────────────────────────────

  export async function status(): Promise<Record<string, Status>> {
    await McpSupervisor.ready()
    const cfg = await Config.current()
    const config = cfg.mcp ?? {}
    const result: Record<string, Status> = {}

    for (const [key, mcp] of Object.entries(config)) {
      if (typeof mcp !== "object" || mcp === null || !("type" in mcp)) continue
      const handle = McpSupervisor.get(key)
      result[key] = handle ? mapStatus(handle) : { status: "disabled" }
    }

    for (const handle of McpSupervisor.getAll()) {
      if (handle.name in result) continue
      result[handle.name] = mapStatus(handle)
    }

    return result
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
    await McpSupervisor.ready()
    const cfg = await Config.current()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      const existing = McpSupervisor.get(name)
      if (existing) {
        existing.retryCount = 0
        await McpSupervisor.connect(name)
        return
      }
      log.error("MCP config not found", { name })
      return
    }
    if (typeof mcp !== "object" || mcp === null || !("type" in mcp)) {
      log.error("Ignoring MCP connect request for config without type", { name })
      return
    }

    const server = Config.normalizeMcp(mcp as Config.Mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout)
    const handle = McpSupervisor.getOrCreate(name, server)
    handle.retryCount = 0
    handle.config = server
    await McpSupervisor.connect(name)
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
    const cfg = await Config.current()
    const callTimeout = cfg.experimental?.mcp_timeout

    for (const handle of McpSupervisor.getAll()) {
      if (mapStatus(handle).status !== "connected") continue
      if (!handle.client || handle.toolDefs.length === 0) continue

      for (const mcpTool of handle.toolDefs) {
        const perServerCallTimeout = await resolveCallTimeout(handle.name)
        const toolName = ToolExposure.mcpToolID(handle.name, mcpTool.name)
        const effectiveCallTimeout = perServerCallTimeout ?? callTimeout
        toolCallTimeouts.set(toolName, effectiveCallTimeout)
        result.push({
          id: toolName,
          serverName: handle.name,
          toolName: mcpTool.name,
          tool: await convertMcpTool(mcpTool, handle.client, effectiveCallTimeout),
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

  export async function startAuth(mcpName: string): Promise<{ authorizationUrl: string }> {
    ensureStarted()
    const cfg = await Config.current()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig) throw new Error(`MCP server not found: ${mcpName}`)
    if (typeof mcpConfig !== "object" || mcpConfig === null || !("type" in mcpConfig)) {
      throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
    }
    if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
    if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)

    await McpOAuthCallback.ensureRunning()

    const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await McpAuth.updateOAuthState(mcpName, oauthState)

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
      },
    )

    const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), { authProvider })

    try {
      const client = new Client({ name: "synergy", version: Installation.VERSION })
      const connectTimeout = await resolveMcpTimeout(mcpName)
      await withTimeout(client.connect(transport), connectTimeout)
      return { authorizationUrl: "" }
    } catch (error) {
      if (error instanceof UnauthorizedError && capturedUrl) {
        pendingOAuthTransports.set(mcpName, transport)
        return { authorizationUrl: capturedUrl.toString() }
      }
      throw error
    }
  }

  export async function authenticate(mcpName: string): Promise<Status> {
    ensureStarted()
    const { authorizationUrl } = await startAuth(mcpName)
    if (!authorizationUrl) {
      return status().then((s) => s[mcpName] ?? { status: "connected" })
    }

    const oauthState = await McpAuth.getOAuthState(mcpName)
    if (!oauthState) throw new Error("OAuth state not found - this should not happen")

    log.info("opening browser for oauth", { mcpName, host: new URL(authorizationUrl).hostname })
    await open(authorizationUrl)

    const code = await McpOAuthCallback.waitForCallback(oauthState)
    const storedState = await McpAuth.getOAuthState(mcpName)
    if (storedState !== oauthState) {
      await McpAuth.clearOAuthState(mcpName)
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }
    await McpAuth.clearOAuthState(mcpName)
    return finishAuth(mcpName, code)
  }

  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    ensureStarted()
    const transport = pendingOAuthTransports.get(mcpName)
    if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

    try {
      await transport.finishAuth(authorizationCode)
      await McpAuth.clearCodeVerifier(mcpName)

      const cfg = await Config.current()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig) throw new Error(`MCP server not found: ${mcpName}`)
      if (typeof mcpConfig !== "object" || mcpConfig === null || !("type" in mcpConfig)) {
        throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
      }

      pendingOAuthTransports.delete(mcpName)
      const server = Config.normalizeMcp(mcpConfig as Config.Mcp, cfg.mcpDefaults, cfg.experimental?.mcp_timeout)
      McpSupervisor.add(mcpName, { ...server, enabled: true })
      const handle = await McpSupervisor.connect(mcpName)
      return mapStatus(handle)
    } catch (error) {
      log.error("failed to finish oauth", { mcpName, error })
      return { status: "failed", error: error instanceof Error ? error.message : String(error) }
    }
  }

  export async function removeAuth(mcpName: string): Promise<void> {
    await McpAuth.remove(mcpName)
    McpOAuthCallback.cancelPending(mcpName)
    pendingOAuthTransports.delete(mcpName)
    await McpAuth.clearOAuthState(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const cfg = await Config.current()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig) return false
    if (typeof mcpConfig !== "object" || mcpConfig === null || !("type" in mcpConfig)) return false
    return mcpConfig.type === "remote" && mcpConfig.oauth !== false
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
