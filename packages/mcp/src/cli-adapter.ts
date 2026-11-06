import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "mcp",
    describe: "manage MCP (Model Context Protocol) servers",
    storage: (positionals) =>
      positionals[1] === "connect" || positionals[1] === "restart" ? undefined : "maintenance",
    load: async () => (await import("./cli/mcp")).McpCommand as unknown as CommandModule,
  },
]
