import type { GateOptions } from "../enforcement/gate"

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

  let pluginSource: PluginSource | undefined

  export function registerPluginSource(source: PluginSource): void {
    pluginSource = source
  }

  export function plugin(): PluginSource | undefined {
    return pluginSource
  }
}
