import { loadComposition } from "./composition"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { Experiment } from "@ericsanchezok/synergy-harness/config/experiment"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tools"

const name = process.argv[2] ?? "core"
const composition = await loadComposition(name)
await composition.register()
const config = process.argv[3] ? await Bun.file(process.argv[3]).json() : {}
Config.schema().strict().parse(config)
if (process.argv[4]) Experiment.File.parse(await Bun.file(process.argv[4]).json())
console.log(
  JSON.stringify({
    version: 1,
    runtime: composition.id,
    configKeys: Object.keys(Config.schema().shape).sort(),
    toolProviders: ToolRegistry.toolProviderIDs().sort(),
  }),
)
