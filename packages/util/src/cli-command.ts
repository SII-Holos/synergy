import type { CommandModule } from "yargs"
export type { CommandModule } from "yargs"

export interface CommandEntry {
  command: string | string[]
  describe: string
  storage?: "maintenance"
  load(): Promise<CommandModule>
}

type WithDoubleDash<T> = T & { "--"?: string[] }

export function cmd<T, U>(input: CommandModule<T, WithDoubleDash<U>>) {
  return input
}
