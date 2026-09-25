import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"
import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"

export async function status(printUpdates: boolean, report: (rows: RuntimeStatusRow[]) => void) {
  return printUpdates ? (await import("./startup-status")).connectionStatusRows(report) : []
}

export const commands: CommandEntry[] = [
  {
    command: "channel",
    describe: "manage messaging channels",
    storage: "maintenance",
    load: async () => (await import("./channel/cli/channel")).ChannelCommand as unknown as CommandModule,
  },
  {
    command: "holos",
    describe: "manage Holos identity and runtime",
    storage: "maintenance",
    load: async () => (await import("./holos/cli/holos")).HolosCommand as unknown as CommandModule,
  },
]
