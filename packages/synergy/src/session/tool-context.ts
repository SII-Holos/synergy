import type { GateOptions } from "../enforcement/gate"
import type { Info as SessionInfo } from "./types"

/**
 * P9 tool execution context (session half): the L1 session tool resolver
 * reaches plugin gate data, plugin tool hooks, and blueprint review/stop
 * access through these registries instead of importing the plugin and
 * blueprint product domains. The L4 product manifest registers the
 * implementations; unregistered accessors degrade quietly (no gate data,
 * hooks pass through, blueprint checks return false).
 */
export namespace SessionToolContext {
  export interface PluginSource {
    /** Fill the plugin-related gate options (registered plugin tools,
     * capability map, approval records) on the given options in place. */
    configureGate(options: GateOptions): Promise<void>
    triggerToolHooks<Input, Output>(
      point: "tool.execute.before" | "tool.execute.after",
      input: Input,
      initial: Output,
      options?: { signal?: AbortSignal },
    ): Promise<Output>
    markToolSchemaDegraded(pluginId: string, toolId: string, error: unknown): Promise<void>
  }

  export interface BlueprintAccess {
    canUseReviewTools(agent: string, reviewSessionID: string, reviewSession?: SessionInfo): Promise<boolean>
    canStopLoop(session: SessionInfo): Promise<boolean>
  }

  let pluginSource: PluginSource | undefined
  let blueprintAccess: BlueprintAccess | undefined

  export function registerPluginSource(source: PluginSource): void {
    pluginSource = source
  }

  export function registerBlueprintAccess(access: BlueprintAccess): void {
    blueprintAccess = access
  }

  export function plugin(): PluginSource | undefined {
    return pluginSource
  }

  export function blueprint(): BlueprintAccess | undefined {
    return blueprintAccess
  }
}
