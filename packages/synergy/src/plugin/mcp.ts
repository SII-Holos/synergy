import { MCP } from "../mcp"
import type { Config } from "../config/config"

/**
 * MCP declaration shape from plugin manifests.
 * Same as Config.Mcp without the `enabled` field (that's a user-config concern).
 */
type McpDeclaration = Omit<Config.Mcp, "enabled">

function isMcpDeclaration(value: unknown): value is McpDeclaration {
  return typeof value === "object" && value !== null && "type" in value
}

/**
 * Namespace a server key with the plugin ID.
 * Plugin MCP keys use the format: "{pluginId}::{serverKey}"
 */
export function namespaceKey(pluginId: string, serverKey: string): string {
  return `${pluginId}::${serverKey}`
}

/**
 * Check if an MCP key belongs to a plugin (contains "::").
 */
export function isPluginMCP(key: string): boolean {
  return key.includes("::")
}

/**
 * Extract the plugin ID from a namespaced MCP key.
 */
export function extractPluginId(key: string): string {
  const idx = key.indexOf("::")
  if (idx === -1) return key
  return key.slice(0, idx)
}

/**
 * Start MCP servers contributed by a plugin.
 * User config always wins — if a server with the same key already exists in user config,
 * the plugin's declaration is skipped.
 */
export async function startForPlugin(pluginId: string, mcpDeclarations: Record<string, unknown>): Promise<void> {
  const statuses = await MCP.status()

  for (const [serverKey, declaration] of Object.entries(mcpDeclarations)) {
    if (!isMcpDeclaration(declaration)) continue
    // User config wins — skip if user already has a server with the same bare key
    if (statuses[serverKey] !== undefined) continue

    const scopedKey = namespaceKey(pluginId, serverKey)

    // Skip if this plugin-scoped server is already running (e.g. from a prior init/reload cycle)
    if (statuses[scopedKey] !== undefined) continue

    const mcpConfig: Config.Mcp = { ...declaration, enabled: true } as Config.Mcp

    await MCP.add(scopedKey, mcpConfig)
  }
}

/**
 * Stop all MCP servers associated with a plugin.
 * Disconnects any MCP client whose key starts with "{pluginId}::".
 */
export async function stopForPlugin(pluginId: string): Promise<void> {
  const statuses = await MCP.status()
  const prefix = `${pluginId}::`

  for (const key of Object.keys(statuses)) {
    if (key.startsWith(prefix)) {
      await MCP.disconnect(key)
    }
  }
}
