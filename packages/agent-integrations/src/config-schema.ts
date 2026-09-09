import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
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
import { ConfigLspCatalog } from "@ericsanchezok/synergy-harness/config/lsp-catalog"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
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

export const ExternalAgentConfig = z
  .object({
    disabled: z.boolean().optional().describe("Disable this external agent"),
    path: z.string().optional().describe("Override path to the external agent binary"),
    model: z.string().optional().describe("Default model for this external agent"),
    auto_discover: z.boolean().optional().describe("Whether to auto-discover this agent on startup (default: true)"),
  })
  .catchall(z.unknown())
  .meta({
    ref: "ExternalAgentConfig",
  })

export type ExternalAgentConfig = z.infer<typeof ExternalAgentConfig>

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
  external_agent: z
    .record(z.string(), ExternalAgentConfig)
    .optional()
    .describe("External agent configurations (e.g. codex, claude-code)"),
  formatter: z
    .union([
      z.literal(false),
      z.record(
        z.string(),
        z.object({
          disabled: z.boolean().optional(),
          command: z.array(z.string()).optional(),
          environment: z.record(z.string(), z.string()).optional(),
          extensions: z.array(z.string()).optional(),
        }),
      ),
    ])
    .optional(),
  lsp: z
    .union([
      z.literal(false),
      z.record(
        z.string(),
        z.union([
          z.object({
            disabled: z.literal(true),
          }),
          z.object({
            command: z.array(z.string()).min(1).optional(),
            extensions: z.array(z.string()).optional(),
            disabled: z.boolean().optional(),
            env: z.record(z.string(), z.string()).optional(),
            initialization: z.record(z.string(), z.any()).optional(),
          }),
        ]),
      ),
    ])
    .optional()
    .refine(
      (data) => {
        if (!data) return true
        if (typeof data === "boolean") return true
        return Object.entries(data).every(([id, config]) => {
          if (config.disabled) return true
          if (ConfigLspCatalog.isKnownServer(id)) return !config.env || Boolean(config.command?.length)
          return Boolean(config.extensions && "command" in config && config.command?.length)
        })
      },
      {
        error: "Custom LSP servers require command and extensions; environment overrides require an explicit command.",
      },
    ),
  lspWriteDiagnostics: z
    .boolean()
    .optional()
    .describe("Include LSP diagnostics after file-writing tools complete (default: true)"),
  lspDiagnostics: z
    .object({
      severity: z.enum(["error", "warning"]).optional(),
      scope: z.enum(["delta", "file", "project"]).optional(),
    })
    .optional()
    .describe("Severity and scope policy for diagnostics returned after file-writing tools"),
  toolExposure: z
    .object({
      lsp: z.boolean().optional().describe("Expose the LSP tool; permission checks still apply (default: false)"),
    })
    .strict()
    .optional(),
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>

declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

export function registerConfig() {
  ConfigExtensions.register("agent-integrations", {
    shape: ConfigShape,
    references(raw, providerID) {
      const config = raw as ConfigValues
      return Object.entries(config.external_agent ?? {}).flatMap(([id, agent]) =>
        agent.model?.startsWith(`${providerID}/`) ? [`external_agent.${id}.model`] : [],
      )
    },
    normalize(raw) {
      const result = raw as ConfigValues
      if (result.lspWriteDiagnostics === undefined) result.lspWriteDiagnostics = true
    },
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
  })
  for (const domain of [
    {
      id: "mcp",
      filename: "40-mcp.jsonc",
      label: "MCP",
      ownedKeys: ["mcp", "mcpDefaults"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "mcp",
      importable: true,
    },
    {
      id: "agents",
      filename: "60-agents.jsonc",
      label: "Agents",
      ownedKeys: ["external_agent"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "agents",
      importable: true,
    },
    {
      id: "runtime",
      filename: "120-runtime.jsonc",
      label: "Runtime",
      ownedKeys: ["formatter", "lsp", "lspWriteDiagnostics", "lspDiagnostics", "toolExposure"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "runtime",
      importable: true,
    },
  ] satisfies ConfigDomain.Definition[])
    ConfigDomain.register(domain)
}
registerConfig()

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
