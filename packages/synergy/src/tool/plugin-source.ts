import type { PluginJsonSchema, PluginSettingCondition } from "@ericsanchezok/synergy-plugin"
import type { ToolDisplay } from "@ericsanchezok/synergy-plugin/tool"
import type { ToolExposure } from "./exposure"

/**
 * S9d plugin tool source: the L1 tool registry loads plugin tool
 * contributions and evaluates their setting conditions through this
 * registered source instead of importing the plugin product domain. The L4
 * product manifest registers the concrete source; unregistered, no plugin
 * tools are contributed.
 */
export namespace ToolPluginSource {
  export interface ExecuteContext {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    userMessageID?: string
    scopeId: string
    directory: string
  }

  export interface Entry {
    fullId: string
    pluginId: string
    toolId: string
    pluginDir: string
    description: string
    inputSchema: PluginJsonSchema
    exposure?: ToolExposure.Info
    display?: ToolDisplay
    enabledWhen?: PluginSettingCondition
    execute(args: unknown, ctx: ExecuteContext): Promise<unknown>
  }

  export interface Source {
    toolEntries(): Promise<Entry[]>
    conditionEnabled(pluginId: string, condition: PluginSettingCondition): Promise<boolean>
  }

  let source: Source | undefined

  export function register(value: Source | undefined): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
