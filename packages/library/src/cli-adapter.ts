import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "library",
    describe: "manage library memory and learning",
    storage: "maintenance",
    load: async () => (await import("./cli/library")).LibraryCommand as unknown as CommandModule,
  },
  {
    command: "embed",
    describe: "manage the local embedding model",
    storage: "maintenance",
    load: async () => (await import("./cli/embed")).EmbedCommand as unknown as CommandModule,
  },
]
