import type { CommandEntry, CommandModule } from "@ericsanchezok/synergy-util/cli-command"
import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
export async function status(printUpdates: boolean, report: (rows: RuntimeStatusRow[]) => void) {
  return printUpdates ? (await import("./startup-status")).connectionStatusRows() : []
}
export const commands: CommandEntry[] = [
  {
    command: "holos",
    describe: "manage holos",
    storage: "maintenance",
    load: async () => (await import("./holos/cli/holos")).HolosCommand as unknown as CommandModule,
  },
]
