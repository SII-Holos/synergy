interface PluginMcpServices {
  replacePluginServers(pluginId: string, declarations: Record<string, unknown>): Promise<void>
  replaceAllPluginServers(candidates: Array<{ pluginId: string; declarations: Record<string, unknown> }>): Promise<void>
}

let services: PluginMcpServices | undefined

export function registerPluginMcpServices(value: PluginMcpServices) {
  services = value
}

export async function startForPlugin(pluginId: string, declarations: Record<string, unknown>): Promise<void> {
  if (!services) {
    if (Object.keys(declarations).length) throw new Error("MCP capability is not registered in this runtime")
    return
  }
  await services.replacePluginServers(pluginId, declarations)
}

export async function stopForPlugin(pluginId: string): Promise<void> {
  await services?.replacePluginServers(pluginId, {})
}

export async function replaceForPlugins(
  candidates: Array<{ pluginId: string; declarations: Record<string, unknown> }>,
): Promise<void> {
  if (!services) {
    if (candidates.some((candidate) => Object.keys(candidate.declarations).length)) {
      throw new Error("MCP capability is not registered in this runtime")
    }
    return
  }
  await services.replaceAllPluginServers(candidates)
}
