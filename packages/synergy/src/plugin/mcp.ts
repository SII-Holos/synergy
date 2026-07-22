import { McpSupervisor } from "../mcp/supervisor"

export async function startForPlugin(pluginId: string, declarations: Record<string, unknown>): Promise<void> {
  await McpSupervisor.replacePluginServers(pluginId, declarations)
}

export async function stopForPlugin(pluginId: string): Promise<void> {
  await McpSupervisor.replacePluginServers(pluginId, {})
}

export async function replaceForPlugins(
  candidates: Array<{ pluginId: string; declarations: Record<string, unknown> }>,
): Promise<void> {
  await McpSupervisor.replaceAllPluginServers(candidates)
}
