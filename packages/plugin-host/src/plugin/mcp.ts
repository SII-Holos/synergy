import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
interface PluginMcpServices {
  replacePluginServers(pluginId: string, declarations: Record<string, unknown>): Promise<void>
  replaceAllPluginServers(candidates: Array<{ pluginId: string; declarations: Record<string, unknown> }>): Promise<void>
}

const runtimeState = RuntimeContext.state(() => ({
  services: undefined as PluginMcpServices | undefined,
}))

export function registerPluginMcpServices(value: PluginMcpServices) {
  const instanceState = runtimeState()

  instanceState.services = value
}

export async function startForPlugin(pluginId: string, declarations: Record<string, unknown>): Promise<void> {
  const instanceState = runtimeState()

  if (!instanceState.services) {
    if (Object.keys(declarations).length) throw new Error("MCP capability is not registered in this runtime")
    return
  }
  await instanceState.services.replacePluginServers(pluginId, declarations)
}

export async function stopForPlugin(pluginId: string): Promise<void> {
  const instanceState = runtimeState()

  await instanceState.services?.replacePluginServers(pluginId, {})
}

export async function replaceForPlugins(
  candidates: Array<{ pluginId: string; declarations: Record<string, unknown> }>,
): Promise<void> {
  const instanceState = runtimeState()

  if (!instanceState.services) {
    if (candidates.some((candidate) => Object.keys(candidate.declarations).length)) {
      throw new Error("MCP capability is not registered in this runtime")
    }
    return
  }
  await instanceState.services.replaceAllPluginServers(candidates)
}
