import type { CommandEntry, CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "org",
    describe: "initialize or serve an organization in an explicit SYNERGY_HOME",
    initialization: "owner",
    load: async () => (await import("./cli/organization")).OrganizationCommand as unknown as CommandModule,
  },
]

export async function standaloneCommands(): Promise<CommandEntry[]> {
  const { organizationCommands } = await import("./cli/organization")
  return organizationCommands.map((command) => {
    if (typeof command.command !== "string" || typeof command.describe !== "string")
      throw new Error("Independent organization commands require names and help text")
    const aliases = typeof command.aliases === "string" ? [command.aliases] : (command.aliases ?? [])
    return {
      command: [command.command, ...aliases],
      describe: command.describe,
      initialization: "owner",
      load: async () => command,
    }
  })
}
