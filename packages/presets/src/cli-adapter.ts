import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "migrate",
    describe: "move synergy data to a new location (alias for 'data move')",
    load: async () => (await import("./cli/data")).MigrateCommand as unknown as CommandModule,
  },
]

export async function dataCommands(): Promise<CommandModule[]> {
  return (await import("./cli/data")).commands as unknown as CommandModule[]
}
