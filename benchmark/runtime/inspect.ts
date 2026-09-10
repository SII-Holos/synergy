import { loadComposition } from "./composition"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { Experiment } from "@ericsanchezok/synergy-harness/config/experiment"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tools"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"

const name = process.argv[2] ?? "core"
const composition = await loadComposition(name)
await composition.register()
const config = process.argv[3] ? await Bun.file(process.argv[3]).json() : {}
Config.schema().strict().parse(config)
const experiment = process.argv[4] ? Experiment.File.parse(await Bun.file(process.argv[4]).json()) : undefined
let measured: unknown
try {
  if (process.argv[5])
    measured = await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const snapshot = Experiment.capture(await Config.current(), experiment, { model: process.argv[5] })
        return Experiment.provide(snapshot, async () => {
          const ref = Provider.parseModel(process.argv[5])
          const model = await Provider.getModel(ref.providerID, ref.modelID)
          const agent = await Agent.get(process.argv[6] || "synergy")
          if (!agent) throw new Error("Unknown benchmark agent")
          if (process.argv[7] && !model.variants?.[process.argv[7]]) throw new Error("Unknown model variant")
          const roles = await Promise.all(
            Provider.ModelRole.options.map(async (role) => {
              const selected = await Provider.resolveRoleModel(role)
              if (!selected) return { role, model: null }
              const value = await Provider.getModel(selected.providerID, selected.modelID)
              return { role, model: { providerID: value.providerID, id: value.id, api: value.api, limit: value.limit } }
            }),
          )
          return {
            model: { providerID: model.providerID, id: model.id, api: model.api, limit: model.limit },
            agent: agent.name,
            roles,
            experiment: snapshot,
          }
        })
      },
    })
  console.log(
    JSON.stringify({
      version: 2,
      runtime: composition.id,
      configKeys: Object.keys(Config.schema().shape).sort(),
      toolProviders: ToolRegistry.toolProviderIDs().sort(),
      measured,
    }),
  )
} finally {
  await ScopeRuntime.disposeAll()
}
