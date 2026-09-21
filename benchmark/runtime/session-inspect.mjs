import { Config } from "synergy/config/config"
import { Provider } from "synergy/provider/provider"
import { Agent } from "synergy/agent/agent"
import { withScopeRuntime } from "synergy/cli/scope"
import { ToolRegistry } from "synergy/tool/registry"

try {
  const [runtime, configFile, experiment, modelID, agentID, variant] = process.argv.slice(2)
  if (runtime !== "full" || experiment)
    throw new Error("Session-export releases require full runtime without experiment overlays")
  Config.Info.parse(await Bun.file(configFile).json())
  const measured = await withScopeRuntime(process.cwd(), async () => {
    const ref = Provider.parseModel(modelID)
    const model = await Provider.getModel(ref.providerID, ref.modelID)
    const agent = await Agent.get(agentID)
    if (!agent || agent.mode === "subagent") throw new Error("Unknown primary benchmark agent")
    if (variant && !model.variants?.[variant]) throw new Error("Unknown model variant")
    const describe = (value) => ({ providerID: value.providerID, id: value.id, api: value.api, limit: value.limit })
    const roles = await Promise.all(
      Provider.ModelRole.options.map(async (role) => {
        const selected = await Provider.resolveRoleModel(role)
        return {
          role,
          model: selected ? describe(await Provider.getModel(selected.providerID, selected.modelID)) : null,
        }
      }),
    )
    return { model: describe(model), agent: agent.name, roles }
  })
  console.log(
    JSON.stringify({
      version: 2,
      runtime: "full",
      runtime_protocol: "synergy-session-v1",
      configKeys: Object.keys(Config.Info.shape).sort(),
      toolProviders: ToolRegistry.toolProviderIDs().sort(),
      measured,
    }),
  )
} catch (error) {
  console.error(error)
  process.exitCode = 2
}
