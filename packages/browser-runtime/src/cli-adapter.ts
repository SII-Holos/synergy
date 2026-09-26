import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "browser",
    describe: "diagnose and install Chromium for Browser tools",
    storage: "maintenance",
    load: async () => (await import("./cli/browser")).BrowserCommand as unknown as CommandModule,
  },
]
