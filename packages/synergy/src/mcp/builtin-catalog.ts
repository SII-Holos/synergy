import z from "zod"
import { McpServerConfig } from "@ericsanchezok/synergy-plugin"

/**
 * Built-in remote MCP search servers shipped enabled by default, keyless.
 *
 * These replace the retired first-party `websearch`, `arxiv_search`, and
 * `arxiv_download` tools. Both servers accept anonymous (no-key) use for
 * their primary search tools; users can add an API key later by configuring
 * the same server key in `40-mcp.jsonc` (a full typed entry overrides the
 * builtin; `{ "enabled": false }` disables it).
 *
 * Injection lives in McpSupervisor.initFromConfig, below user config and at
 * the same precedence as plugin-staged servers. Tests and CI disable the
 * catalog with SYNERGY_DISABLE_BUILTIN_MCP so no test ever connects to these
 * endpoints.
 */

export const DISABLE_BUILTIN_MCP_ENV = "SYNERGY_DISABLE_BUILTIN_MCP"

export interface BuiltinMcpServer {
  name: string
  config: z.infer<typeof McpServerConfig>
}

const RAW_CATALOG: Record<string, unknown> = {
  anysearch: {
    type: "remote",
    url: "https://api.anysearch.com/mcp",
    // Static-Bearer / anonymous auth; do not run the OAuth probe.
    oauth: false,
    startup: "eager",
  },
  scholight: {
    type: "remote",
    url: "https://scholight.sanchezcloud.net/api/mcp",
    // Static-Bearer / anonymous auth; do not run the OAuth probe.
    oauth: false,
    startup: "eager",
  },
}

let cached: BuiltinMcpServer[] | undefined

function catalog(): BuiltinMcpServer[] {
  if (cached) return cached
  cached = Object.entries(RAW_CATALOG).map(([name, value]) => {
    const parsed = McpServerConfig.safeParse(value)
    if (!parsed.success) {
      throw new Error(
        `Builtin MCP server "${name}" no longer matches the server schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    return { name, config: parsed.data }
  })
  return cached
}

function envTruthy(key: string): boolean {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

/** True when builtin MCP servers are disabled (tests/CI/escape hatch). */
export function builtinMcpDisabled(): boolean {
  return envTruthy(DISABLE_BUILTIN_MCP_ENV)
}

/**
 * A user-configured entry shadows the builtin when it is a full typed server
 * (override) or an explicit `enabled: false` stub (opt-out). A bare
 * `enabled: true` stub or a credential-only `apiKey` stub does not own the
 * name, so the builtin stays active.
 */
function userOwnsServer(entry: unknown): boolean {
  if (entry === null || entry === undefined) return false
  if (typeof entry !== "object") return true
  const record = entry as Record<string, unknown>
  if (record.enabled === false) return true
  return typeof record.type === "string"
}

/** Catalog names and URLs, for surfaces that list builtins without staging them. */
export function builtinMcpServerInfos(): Array<{ name: string; url: string }> {
  if (builtinMcpDisabled()) return []
  return catalog().map(({ name, config }) => ({
    name,
    url: config.type === "remote" ? config.url : "",
  }))
}

/**
 * Non-empty API key stored on a built-in server stub. An empty string is the
 * clear marker and behaves like an absent key.
 */
export function builtinApiKeyOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
  const apiKey = (entry as Record<string, unknown>).apiKey
  return typeof apiKey === "string" && apiKey.trim() !== "" ? apiKey : undefined
}

/** Builtin entries to stage for the given merged user config (may be empty). */
export function collectBuiltinMcpServers(userMcp: Record<string, unknown> | undefined): BuiltinMcpServer[] {
  if (builtinMcpDisabled()) return []
  const user = userMcp ?? {}
  return catalog()
    .filter(({ name }) => !userOwnsServer(user[name]))
    .map(({ name, config }) => {
      const apiKey = builtinApiKeyOf(user[name])
      if (!apiKey || config.type !== "remote") return { name, config }
      return {
        name,
        config: {
          ...config,
          headers: { ...(config.headers ?? {}), Authorization: `Bearer ${apiKey}` },
        },
      }
    })
}
