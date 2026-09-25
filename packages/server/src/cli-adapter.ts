import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "generate",
    describe: "generate the OpenAPI contract",
    load: async () => (await import("./cli/generate")).GenerateCommand as unknown as CommandModule,
  },
]
