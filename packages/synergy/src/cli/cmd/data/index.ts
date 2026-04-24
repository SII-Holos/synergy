import { cmd } from "../cmd"
import { DataPathCommand } from "./path"
import { DataSetHomeCommand } from "./set-home"
import { DataMoveCommand } from "./move"
import { DataPackCommand } from "./pack"
import { DataMergeCommand } from "./merge"

export const DataCommand = cmd({
  command: "data",
  describe: "manage synergy data location and storage",
  builder: (yargs) =>
    yargs
      .command(DataPathCommand)
      .command(DataSetHomeCommand)
      .command(DataMoveCommand)
      .command(DataPackCommand)
      .command(DataMergeCommand)
      .demandCommand(),
  async handler() {},
})

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

    const { executeMove } = await import("./move")
    await executeMove({ target, removeOriginal, dryRun })
  },
})
