import { McpSupervisor } from "../mcp/supervisor"

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
