import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"
import type { createAcpCommand } from "./cli/acp"

export function createCommands(context: { openHttp: Parameters<typeof createAcpCommand>[0] }): CommandEntry[] {
  return [
    {
      command: "acp",
      describe: "start ACP (Agent Client Protocol) server",
      load: async () => (await import("./cli/acp")).createAcpCommand(context.openHttp) as unknown as CommandModule,
    },
  ]
}
