import { McpSupervisor } from "../mcp/supervisor"

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
 * Delegates to McpSupervisor.registerPluginServers which handles
 * bare-key shadow, defaults deep-merge, and Config.normalizeMcp.
 */
export async function startForPlugin(pluginId: string, mcpDeclarations: Record<string, unknown>): Promise<void> {
  await McpSupervisor.registerPluginServers(pluginId, mcpDeclarations)
}

/**
 * Stop all MCP servers associated with a plugin.
 * Delegates to McpSupervisor.unregisterPluginServers.
 */
export async function stopForPlugin(pluginId: string): Promise<void> {
  await McpSupervisor.unregisterPluginServers(pluginId)
}
