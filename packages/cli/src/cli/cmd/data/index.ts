import type { CommandModule } from "yargs"
import { DataSnapshotsCommand } from "./snapshots"
import { cmd } from "../cmd"
import { DataPathCommand } from "./path"
import { DataSetHomeCommand } from "./set-home"

export function createDataCommand(commands: CommandModule[] = []) {
  return cmd({
    command: "data",
    describe: "manage synergy data location and storage",
    builder: (yargs) =>
      yargs
        .command(DataSnapshotsCommand)
        .command(DataPathCommand)
        .command(DataSetHomeCommand)
        .command(commands)
        .demandCommand(),
    async handler() {},
  })
}

export const DataCommand = createDataCommand()
