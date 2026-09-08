import { cmd } from "@ericsanchezok/synergy-cli/cli/cmd/cmd"
import { createDataCommand } from "@ericsanchezok/synergy-cli/cli/cmd/data"
import { DataMoveCommand } from "./move"
import { DataPackCommand } from "./pack"
import { DataMergeCommand } from "./merge"
import type { CommandModule } from "yargs"
export const commands = [DataMoveCommand, DataPackCommand, DataMergeCommand] as CommandModule[]
export const DataCommand = createDataCommand(commands)
/** Backward-compatible alias: `synergy migrate` → `synergy data move` */
export const MigrateCommand = cmd({
  command: "migrate",
  describe: "move synergy data to a new location (alias for 'data move')",
  builder: (yargs) =>
    yargs
      .option("target", { type: "string", describe: "target directory path" })
      .option("remove-original", {
        type: "boolean",
        default: false,
        describe: "remove original data after successful move",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "show plan without executing",
      }),
  handler: async (args) => {
    const target = args.target as string | undefined
    const removeOriginal = args.removeOriginal as boolean
    const dryRun = args.dryRun as boolean

    const { executeMove } = await import("@ericsanchezok/synergy-product-runtime/cli/data/move")
    await executeMove({ target, removeOriginal, dryRun })
  },
})
