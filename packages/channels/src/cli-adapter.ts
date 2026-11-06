import type { CommandEntry, CommandModule } from "@ericsanchezok/synergy-util/cli-command"
import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
export async function status(printUpdates: boolean, report: (rows: RuntimeStatusRow[]) => void) {
  return printUpdates ? (await import("./startup-status")).connectionStatusRows(report) : []
}
export const commands: CommandEntry[] = [
  {
    command: "channel",
    describe: "manage channel",
    storage: "maintenance",
    load: async () => (await import("./channel/cli/channel")).ChannelCommand as unknown as CommandModule,
  },
]
