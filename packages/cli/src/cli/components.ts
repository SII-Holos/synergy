import type { CommandModule } from "yargs"
import type { CommandEntry } from "@ericsanchezok/synergy-util/cli-command"
import type { RuntimeComponent, RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import type { LocalRuntimeOptions } from "@ericsanchezok/synergy-local-runtime"
import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"

export interface CliAdapterContext {
  openHttp(
    options: LocalRuntimeOptions,
  ): Promise<RuntimeHandle.Handle & { server: NonNullable<RuntimeHandle.Handle["server"]> }>
}

export interface CliAdapter {
  commands?: CommandEntry[]
  createCommands?(context: CliAdapterContext): CommandEntry[]
  dataCommands?(): Promise<CommandModule[]>
  debugCommands?(): Promise<CommandModule[]>
  pluginCommands?(): Promise<CommandModule[]>
  status?(printUpdates: boolean, report: (rows: RuntimeStatusRow[]) => void): Promise<RuntimeStatusRow[]>
}

export async function loadCliAdapters(components: readonly RuntimeComponent[], context: CliAdapterContext) {
  const adapters = await Promise.all(
    components
      .flatMap((component) => (component.adapters?.cli ? [component.adapters.cli] : []))
      .map(async (entry): Promise<CliAdapter> => import(entry.href)),
  )
  const commands = adapters.flatMap((adapter) => [
    ...(adapter.commands ?? []),
    ...(adapter.createCommands?.(context) ?? []),
  ])
  const names = new Set<string>()
  for (const entry of commands) {
    for (const command of Array.isArray(entry.command) ? entry.command : [entry.command]) {
      const name = command.split(" ")[0]
      if (names.has(name)) throw new Error(`Component CLI has a duplicate command: ${name}`)
      names.add(name)
    }
  }
  const nested = async (kind: "dataCommands" | "debugCommands" | "pluginCommands") =>
    (await Promise.all(adapters.map((adapter) => adapter[kind]?.() ?? []))).flat()
  return {
    commands,
    dataCommands: () => nested("dataCommands"),
    debugCommands: () => nested("debugCommands"),
    pluginCommands: () => nested("pluginCommands"),
    status: async (printUpdates: boolean, report: (rows: RuntimeStatusRow[]) => void) =>
      (await Promise.all(adapters.map((adapter) => adapter.status?.(printUpdates, report) ?? []))).flat(),
  }
}
