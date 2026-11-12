import type { CommandEntry, CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export const commands: CommandEntry[] = [
  {
    command: "member-runtime",
    describe: "serve a prepared member Runtime from a private supervisor request",
    initialization: "owner",
    load: async () => (await import("./cli/member")).MemberRuntimeCommand as unknown as CommandModule,
  },
  {
    command: "hosted-runtime",
    describe: "serve a prepared organization-hosted Runtime from a private supervisor request",
    initialization: "owner",
    load: async () => (await import("./cli/hosted")).HostedRuntimeCommand as unknown as CommandModule,
  },
  {
    command: "org-runtime",
    describe: "register or serve an independent organization Runtime",
    initialization: "owner",
    load: async () =>
      (await import("./cli/organization-runtime")).OrganizationRuntimeCommand as unknown as CommandModule,
  },
]

export async function standaloneCommands(): Promise<CommandEntry[]> {
  const { organizationRuntimeCommands } = await import("./cli/organization-runtime")
  const publicCommands = organizationRuntimeCommands.map((command) => {
    if (typeof command.command !== "string" || typeof command.describe !== "string")
      throw new Error("Independent machine commands require names and help text")
    return {
      command: command.command,
      describe: command.describe,
      initialization: "owner" as const,
      load: async () => command,
    }
  })
  return [...publicCommands, ...commands.filter((command) => command.command !== "org-runtime")]
}
