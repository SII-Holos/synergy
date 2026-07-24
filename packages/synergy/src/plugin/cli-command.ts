import type { PluginCliCommandResult, PluginManifestType } from "@ericsanchezok/synergy-plugin"
import type { CommandModule } from "yargs"
import type { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import type { RuntimeInvocationContextData } from "../plugin-runtime/protocol"
import type { LoadedPlugin } from "./loader"
import { ensureRuntime, getPlugin } from "./loader"
import { pluginRuntimeManager } from "./runtime"

export type PluginCliCommand = Extract<PluginManifestType["contributions"][number], { kind: "cli.command" }>

export function resolvePluginCliCommand(
  manifest: { contributions: readonly unknown[] },
  commandId: string,
): PluginCliCommand {
  const command = manifest.contributions.find((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const contribution = item as Record<string, unknown>
    return contribution.kind === "cli.command" && contribution.id === commandId
  }) as PluginCliCommand | undefined
  if (!command) throw new Error(`Plugin CLI command not found: ${commandId}`)
  return command
}

type InvokePluginCliCommand = typeof invokePluginCliCommand

interface PluginCliWriter {
  write(chunk: string): unknown
}

export function createPluginCliCommandModule(input: {
  plugin: LoadedPlugin
  resolveScope: () => Promise<Scope>
  invoke?: InvokePluginCliCommand
  stdout?: PluginCliWriter
  stderr?: PluginCliWriter
}): CommandModule {
  const invoke = input.invoke ?? invokePluginCliCommand
  const stdout = input.stdout ?? process.stdout
  const stderr = input.stderr ?? process.stderr
  const commands = input.plugin.manifest.contributions
    .filter((item): item is PluginCliCommand => item.kind === "cli.command")
    .toSorted((left, right) => left.id.localeCompare(right.id))

  return {
    command: input.plugin.id,
    describe: `${input.plugin.manifest.name} plugin commands`,
    builder: (yargs) => {
      for (const command of commands) {
        yargs.command({
          command: command.id,
          describe: command.description,
          builder: (commandYargs) => {
            for (const [name, option] of Object.entries(command.options)) {
              commandYargs.option(name, { type: option.type, describe: option.description })
            }
            return commandYargs
          },
          handler: async (args) => {
            const scope = await input.resolveScope()
            await ScopeContext.provide({
              scope,
              async fn() {
                const options = Object.fromEntries(
                  Object.keys(command.options).flatMap((name) =>
                    args[name] === undefined ? [] : [[name, args[name]]],
                  ),
                )
                const output = await invoke({
                  pluginId: input.plugin.id,
                  commandId: command.id,
                  args: options,
                })
                if (output.stdout) stdout.write(output.stdout)
                if (output.stderr) stderr.write(output.stderr)
                process.exitCode = output.exitCode
              },
            })
          },
        })
      }
      return yargs.demandCommand()
    },
    handler() {},
  }
}

interface PluginCliCommandServices {
  scope: { id: string; directory: string }
  getPlugin(pluginId: string): Promise<LoadedPlugin | undefined>
  ensureRuntime(plugin: LoadedPlugin): Promise<unknown>
  invoke(input: {
    pluginId: string
    handlerId: string
    value: Record<string, unknown>
    context: RuntimeInvocationContextData
    pluginDir: string
    manifest: PluginManifestType
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<unknown>
}

function defaultServices(): PluginCliCommandServices {
  return {
    scope: { id: ScopeContext.current.scope.id, directory: ScopeContext.current.directory },
    getPlugin,
    ensureRuntime,
    invoke: (input) => pluginRuntimeManager.invoke(input),
  }
}

export async function invokePluginCliCommand(
  input: {
    pluginId: string
    commandId: string
    args: Record<string, unknown>
    signal?: AbortSignal
  },
  services: PluginCliCommandServices = defaultServices(),
): Promise<PluginCliCommandResult> {
  const plugin = await services.getPlugin(input.pluginId)
  if (!plugin) throw new Error(`Plugin not found: ${input.pluginId}`)
  if (!plugin.enabledScopes.has(services.scope.id)) {
    throw new Error(`Plugin is not enabled in this Scope: ${input.pluginId}`)
  }

  const command = resolvePluginCliCommand(plugin.manifest, input.commandId)
  await services.ensureRuntime(plugin)
  const output = await services.invoke({
    pluginId: plugin.id,
    handlerId: `cli.command:${command.id}`,
    value: input.args,
    context: {
      scopeId: services.scope.id,
      directory: services.scope.directory,
      actor: { type: "cli" },
    },
    pluginDir: plugin.pluginDir,
    manifest: plugin.manifest,
    timeoutMs: command.timeoutMs,
    signal: input.signal,
  })
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error(`Plugin CLI command returned an invalid result: ${command.id}`)
  }
  const result = output as Record<string, unknown>
  if (
    !Number.isInteger(result.exitCode) ||
    (result.stdout !== undefined && typeof result.stdout !== "string") ||
    (result.stderr !== undefined && typeof result.stderr !== "string")
  ) {
    throw new Error(`Plugin CLI command returned an invalid result: ${command.id}`)
  }
  return result as PluginCliCommandResult
}
