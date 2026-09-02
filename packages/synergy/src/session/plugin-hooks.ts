/**
 * S9c source inversion: the L1 session domain delivers plugin lifecycle
 * hooks (chat/system/params/turn transforms, cortex task notifications)
 * through this registry instead of importing the plugin product domain. The
 * L4 product manifest registers the delivery functions; unregistered
 * delivery passes the initial value through unchanged.
 */
export namespace SessionPluginHooks {
  export interface TriggerOptions {
    sessionId?: string
    signal?: AbortSignal
  }

  let triggerFn:
    | (<Input, Output>(point: string, input: Input, initial: Output, options?: TriggerOptions) => Promise<Output>)
    | undefined
  let triggerForPluginFn:
    | (<Input, Output>(
        pluginId: string,
        pluginGeneration: string,
        point: string,
        input: Input,
        initial: Output,
      ) => Promise<Output>)
    | undefined

  export function registerTrigger(
    value: <Input, Output>(point: string, input: Input, initial: Output, options?: TriggerOptions) => Promise<Output>,
  ): void {
    triggerFn = value
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
    triggerForPluginFn = value
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
    if (!triggerFn) return Promise.resolve(initial)
    return triggerFn(point, input, initial, options)
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
    if (!triggerForPluginFn) return Promise.resolve(initial)
    return triggerForPluginFn(pluginId, pluginGeneration, point, input, initial)
  }
}
