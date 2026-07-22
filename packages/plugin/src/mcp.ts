import z from "zod"

export const McpRetryConfig = z
  .object({
    maxAttempts: z.number().int().positive().optional().describe("Maximum connection attempts before giving up"),
    backoffMs: z.number().int().positive().optional().describe("Initial backoff delay in ms between retries"),
    backoffMultiplier: z.number().positive().optional().describe("Multiplier applied to backoff on each retry"),
    cooldownMs: z.number().int().nonnegative().optional().describe("Cooldown period in ms before a retry cycle resets"),
  })
  .strict()
  .meta({ ref: "McpRetryConfig" })
export type McpRetryConfig = z.infer<typeof McpRetryConfig>

export const McpToolFilterConfig = z
  .object({
    include: z.array(z.string()).optional().describe("Tool names to include (allowlist)"),
    exclude: z.array(z.string()).optional().describe("Tool names to exclude (blocklist)"),
  })
  .strict()
  .meta({ ref: "McpToolFilterConfig" })
export type McpToolFilterConfig = z.infer<typeof McpToolFilterConfig>

export const McpToolsConfig = z
  .object({
    approval: z.enum(["auto", "always", "per_session"]).optional().describe("Tool approval mode"),
    maxOutputBytes: z.number().int().positive().optional().describe("Maximum tool output size in bytes"),
  })
  .strict()
  .meta({ ref: "McpToolsConfig" })
export type McpToolsConfig = z.infer<typeof McpToolsConfig>

export const McpToolCacheConfig = z
  .object({
    mode: z.enum(["disabled", "session", "persistent"]).optional().describe("Tool list caching mode"),
    ttlMs: z.number().int().positive().optional().describe("Time-to-live for cached tool list in ms"),
  })
  .strict()
  .meta({ ref: "McpToolCacheConfig" })
export type McpToolCacheConfig = z.infer<typeof McpToolCacheConfig>

export const McpLifecycleFields = {
  startup: z.enum(["eager", "lazy", "manual"]).optional().describe("MCP startup mode"),
  required: z.boolean().optional().describe("If true, this MCP server is required for the configured workflow"),
  connectTimeout: z.number().int().positive().optional().describe("Timeout in ms for initial connection handshake"),
  listTimeout: z.number().int().positive().optional().describe("Timeout in ms for listing tools"),
  callTimeout: z.number().int().positive().optional().describe("Timeout in ms for tool call execution"),
  retry: McpRetryConfig.optional().describe("Retry policy for connecting to this server"),
  idleShutdownMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Idle time in ms after which the server is shut down"),
  toolFilter: McpToolFilterConfig.optional().describe("Filter which tools are exposed from this server"),
  tools: McpToolsConfig.optional().describe("Tool execution behavior config"),
  toolCache: McpToolCacheConfig.optional().describe("Tool list caching behavior"),
} satisfies z.core.$ZodLooseShape

export const McpLifecycleConfig = z.object(McpLifecycleFields).strict().meta({ ref: "McpLifecycleConfig" })
export type McpLifecycleConfig = z.infer<typeof McpLifecycleConfig>
export type McpLifecycleFields = McpLifecycleConfig

const LegacyTimeout = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Deprecated legacy timeout in ms for MCP operations. Prefer connectTimeout/listTimeout/callTimeout.")

const HttpUrl = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  }, "MCP remote URL must use http or https")

export const McpOAuthConfig = z
  .object({
    clientId: z
      .string()
      .optional()
      .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
    clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
    scope: z.string().optional().describe("OAuth scopes to request during authorization"),
  })
  .strict()
  .meta({ ref: "McpOAuthConfig" })
export type McpOAuthConfig = z.infer<typeof McpOAuthConfig>

export const McpLocalServerConfig = z
  .object({
    type: z.literal("local").describe("Type of MCP server connection"),
    command: z.array(z.string().min(1)).min(1).describe("Command and arguments to run the MCP server"),
    cwd: z.string().optional().describe("Working directory for local MCP servers"),
    environment: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables to set when running the MCP server"),
    timeout: LegacyTimeout,
    ...McpLifecycleFields,
  })
  .strict()
  .meta({ ref: "McpLocalServerConfig" })
export type McpLocalServerConfig = z.infer<typeof McpLocalServerConfig>

export const McpRemoteServerConfig = z
  .object({
    type: z.literal("remote").describe("Type of MCP server connection"),
    url: HttpUrl.describe("URL of the remote MCP server"),
    headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
    oauth: z
      .union([McpOAuthConfig, z.literal(false)])
      .optional()
      .describe("OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection."),
    timeout: LegacyTimeout,
    ...McpLifecycleFields,
  })
  .strict()
  .meta({ ref: "McpRemoteServerConfig" })
export type McpRemoteServerConfig = z.infer<typeof McpRemoteServerConfig>

export const McpServerConfig = z.discriminatedUnion("type", [McpLocalServerConfig, McpRemoteServerConfig])
export type McpServerConfig = z.infer<typeof McpServerConfig>
