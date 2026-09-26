import { RuntimeContext } from "../lifecycle/context"
import type { Provider as SDK } from "ai"

export namespace ProviderSdkSource {
  export type Factory = (options: Record<string, unknown>) => SDK

  export interface Source {
    load(packageName: string): Promise<Factory | undefined>
    loadSync(packageName: string): Factory | undefined
  }

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source | undefined): void {
    const instanceState = runtimeState()

    if (instanceState.source === value) return
    RuntimeContext.assertCompositionOpen("provider/sdk-source")
    if (instanceState.source && value) throw new Error("provider/sdk-source is already registered")
    instanceState.source = value
  }

  function requireSource(): Source {
    const instanceState = runtimeState()

    if (!instanceState.source)
      throw new Error("Provider SDK source is not registered; compose a runtime or register a research SDK source")
    return instanceState.source
  }

  function requireFactory(packageName: string, factory: Factory | undefined): Factory {
    if (!factory) throw new Error(`Unsupported provider SDK "${packageName}"`)
    return factory
  }

  export async function load(packageName: string): Promise<Factory> {
    return requireFactory(packageName, await requireSource().load(packageName))
  }

  export function loadSync(packageName: string): Factory {
    return requireFactory(packageName, requireSource().loadSync(packageName))
  }
}
