import { RuntimeContext } from "../lifecycle/context"
/**
 * S9c source inversion: the L1 session domain delivers plugin lifecycle
 * hooks (chat/system/params/turn transforms, cortex task notifications)
 * through this registry instead of importing the plugin product domain. The
 * L4 product manifest registers the delivery functions; unregistered
 * delivery passes the initial value through unchanged.
 */
export namespace SessionPluginHooks {
  export type Installed = { id: string; version: string; generation: string; manifestHash: string }
  const runtimeState = RuntimeContext.state(() => ({
    installedFn: undefined as (() => Promise<Installed[]>) | undefined,
    triggerFn: undefined as
      | (<Input, Output>(point: string, input: Input, initial: Output, options?: TriggerOptions) => Promise<Output>)
      | undefined,
    triggerForPluginFn: undefined as
      | (<Input, Output>(
          pluginId: string,
          pluginGeneration: string,
          point: string,
          input: Input,
          initial: Output,
        ) => Promise<Output>)
      | undefined,
  }))
  export function registerInstalled(value: () => Promise<Installed[]>) {
    const instanceState = runtimeState()

    instanceState.installedFn = value
  }
  export function installed(): Promise<Installed[]> {
    const instanceState = runtimeState()

    return instanceState.installedFn?.() ?? Promise.resolve([])
  }

  export interface TriggerOptions {
    sessionId?: string
    signal?: AbortSignal
  }

  export function registerTrigger(
    value: <Input, Output>(point: string, input: Input, initial: Output, options?: TriggerOptions) => Promise<Output>,
  ): void {
    const instanceState = runtimeState()

    instanceState.triggerFn = value
  }

  export function registerTriggerForPlugin(
    value: <Input, Output>(
      pluginId: string,
      pluginGeneration: string,
      point: string,
      input: Input,
      initial: Output,
    ) => Promise<Output>,
  ): void {
    const instanceState = runtimeState()

    instanceState.triggerForPluginFn = value
  }

  /** Fire a plugin hook point. Falls back to the initial output when no
   * delivery is registered so the session loop stays runnable without the
   * product manifest (tests, library consumers). */
  export function trigger<Input, Output>(
    point: string,
    input: Input,
    initial: Output,
    options?: TriggerOptions,
  ): Promise<Output> {
    const instanceState = runtimeState()

    if (!instanceState.triggerFn) return Promise.resolve(initial)
    return instanceState.triggerFn(point, input, initial, options)
  }

  /** Fire a plugin-owned hook point (generation-checked). Falls back to the
   * initial output when no delivery is registered. */
  export function triggerForPlugin<Input, Output>(
    pluginId: string,
    pluginGeneration: string,
    point: string,
    input: Input,
    initial: Output,
  ): Promise<Output> {
    const instanceState = runtimeState()

    if (!instanceState.triggerForPluginFn) return Promise.resolve(initial)
    return instanceState.triggerForPluginFn(pluginId, pluginGeneration, point, input, initial)
  }
}
