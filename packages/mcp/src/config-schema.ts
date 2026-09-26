import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import z from "zod"
import {
  McpLifecycleFields,
  McpLocalServerConfig,
  McpOAuthConfig,
  McpRemoteServerConfig,
  McpRetryConfig,
  McpToolCacheConfig,
  McpToolFilterConfig,
  McpToolsConfig,
} from "@ericsanchezok/synergy-plugin"
export const McpRetry = McpRetryConfig

export type McpRetry = McpRetryConfig

export const McpToolFilter = McpToolFilterConfig

export type McpToolFilter = McpToolFilterConfig

export const McpTools = McpToolsConfig

export type McpTools = McpToolsConfig

export const McpToolCache = McpToolCacheConfig

export type McpToolCache = McpToolCacheConfig

const McpEnabled = {
  enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
}

export const McpLocal = McpLocalServerConfig.extend(McpEnabled).strict().meta({ ref: "McpLocalConfig" })

export const McpOAuth = McpOAuthConfig

export type McpOAuth = McpOAuthConfig

export const McpRemote = McpRemoteServerConfig.extend(McpEnabled).strict().meta({ ref: "McpRemoteConfig" })

export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])

export type Mcp = z.infer<typeof Mcp>

export const McpDefaults = z.object(McpLifecycleFields).strict().meta({ ref: "McpDefaultsConfig" })

export type McpDefaults = z.infer<typeof McpDefaults>

export const ConfigShape = {
  mcp: z
    .record(
      z.string(),
      z.union([
        Mcp,
        z
          .object({
            enabled: z.boolean().optional(),
            // Built-in server stub: add a credential (apiKey), opt out of
            // the builtin (enabled:false), or override expansion
            // (expandByDefault) without owning the builtin config. The key
            // is injected as a Bearer header at staging; empty clears.
            apiKey: z.string().optional(),
            expandByDefault: z
              .boolean()
              .optional()
              .describe(
                "Keep this built-in server's tools always visible to the model instead of folding them into an expandable MCP group",
              ),
          })
          .strict()
          .refine((stub) => "enabled" in stub || "apiKey" in stub || "expandByDefault" in stub, {
            error: "Built-in server stubs must set at least one field",
          }),
      ]),
    )
    .optional()
    .describe("MCP (Model Context Protocol) server configurations"),
  mcpDefaults: McpDefaults.optional().describe("Default settings applied to all MCP servers that don't override them"),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

const contribution: ConfigExtensions.Contribution = {
  shape: ConfigShape,
  redact(raw, helpers) {
    const result = raw as ConfigValues
    const REDACTED_SENTINEL = helpers.sentinel
    const redactSecretShapedRecord = helpers.redact
    const mergeSecretShapedRecord = helpers.restore

    if (result.mcp) {
      for (const server of Object.values(result.mcp) as any[]) {
        if (server?.oauth?.clientSecret) server.oauth.clientSecret = REDACTED_SENTINEL
        if (server?.headers) redactSecretShapedRecord(server.headers)
        if (server?.environment) redactSecretShapedRecord(server.environment)
        if (server?.apiKey) server.apiKey = REDACTED_SENTINEL
      }
    }
  },
  restore(raw, previous, helpers) {
    const result = raw as ConfigValues
    const stored = previous as ConfigValues
    const REDACTED_SENTINEL = helpers.sentinel
    const redactSecretShapedRecord = helpers.redact
    const mergeSecretShapedRecord = helpers.restore

    if (result.mcp && stored.mcp) {
      for (const [key, server] of Object.entries(result.mcp) as [string, any][]) {
        const storedServer = (stored.mcp as Record<string, any>)[key]
        if (server?.oauth?.clientSecret === REDACTED_SENTINEL) {
          if (storedServer?.oauth?.clientSecret) server.oauth.clientSecret = storedServer.oauth.clientSecret
        }
        if (server?.headers) mergeSecretShapedRecord(server.headers, storedServer?.headers)
        if (server?.environment) mergeSecretShapedRecord(server.environment, storedServer?.environment)
        if (server?.apiKey === REDACTED_SENTINEL && storedServer?.apiKey) {
          server.apiKey = storedServer.apiKey
        }
      }
    }
  },
}

export function registerConfig() {
  ConfigExtensions.register("mcp", contribution)
  ConfigDomain.register({
    id: "mcp",
    filename: "40-mcp.jsonc",
    label: "MCP",
    ownedKeys: ["mcp", "mcpDefaults"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "mcp",
    importable: true,
  })
}
export function normalizeMcp(server: Mcp, defaults?: McpDefaults, defaultCallTimeoutMs?: number): Mcp {
  const result = { ...server }
  const legacyTimeout = result.timeout

  if (legacyTimeout !== undefined) {
    if (result.connectTimeout === undefined) result.connectTimeout = legacyTimeout
    if (result.listTimeout === undefined) result.listTimeout = legacyTimeout
    if (result.callTimeout === undefined) result.callTimeout = legacyTimeout
  }

  if (defaultCallTimeoutMs !== undefined && result.callTimeout === undefined) {
    result.callTimeout = defaultCallTimeoutMs
  }

  if (defaults) {
    if (result.startup === undefined) result.startup = defaults.startup
    if (result.required === undefined) result.required = defaults.required
    if (result.connectTimeout === undefined) result.connectTimeout = defaults.connectTimeout
    if (result.listTimeout === undefined) result.listTimeout = defaults.listTimeout
    if (result.callTimeout === undefined) result.callTimeout = defaults.callTimeout
    if (result.idleShutdownMs === undefined) result.idleShutdownMs = defaults.idleShutdownMs
    if (result.retry === undefined) result.retry = defaults.retry
    if (result.toolFilter === undefined) result.toolFilter = defaults.toolFilter
    if (result.tools === undefined) result.tools = defaults.tools
    if (result.toolCache === undefined) result.toolCache = defaults.toolCache
    if (result.expandByDefault === undefined) result.expandByDefault = defaults.expandByDefault
  }

  result.startup ??= "eager"
  return result
}

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
