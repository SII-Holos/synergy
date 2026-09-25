import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "stats",
    describe: "show token usage and cost statistics",
    storage: "maintenance",
    load: async () => (await import("./stats/cli/stats")).StatsCommand as unknown as CommandModule,
  },
]
