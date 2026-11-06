import type { CommandModule } from "@ericsanchezok/synergy-util/cli-command"

export async function debugCommands(): Promise<CommandModule[]> {
  return [(await import("./cli/debug")).LSPCommand as unknown as CommandModule]
}
