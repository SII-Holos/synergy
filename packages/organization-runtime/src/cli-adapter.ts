import type { CommandEntry, CommandModule } from "@ericsanchezok/synergy-util/cli-command"
import type { CleanupRuntimeFactory } from "./cli/cleanup"

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
    describe: "register, serve or clean up an independent organization Runtime",
    initialization: "owner",
    load: async () =>
      (await import("./cli/organization-runtime")).OrganizationRuntimeCommand as unknown as CommandModule,
  },
]

export async function standaloneCommands(
  options: { cleanupRuntime?: CleanupRuntimeFactory } = {},
): Promise<CommandEntry[]> {
  const { organizationRuntimeCommands } = await import("./cli/organization-runtime")
  const { createCleanupCommand } = await import("./cli/cleanup")
  const publicCommands = organizationRuntimeCommands.map((original) => {
    const command =
      original.command === "cleanup" && options.cleanupRuntime ? createCleanupCommand(options.cleanupRuntime) : original
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
