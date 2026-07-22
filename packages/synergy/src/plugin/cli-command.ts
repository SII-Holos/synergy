import type { PluginCliCommandResult, PluginManifestType } from "@ericsanchezok/synergy-plugin"
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
