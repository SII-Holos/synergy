import type { CommandModule } from "yargs"

export async function pluginCommands(): Promise<CommandModule[]> {
  return Object.entries(await import("./commands/index.js"))
    .filter(([name]) => name.endsWith("Command"))
    .map(([, command]) => command as CommandModule)
}
