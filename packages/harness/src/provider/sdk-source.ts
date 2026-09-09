import type { Provider as SDK } from "ai"

export namespace ProviderSdkSource {
  export type Factory = (options: Record<string, unknown>) => SDK

  export interface Source {
    load(packageName: string): Promise<Factory | undefined>
    loadSync(packageName: string): Factory | undefined
  }

  let source: Source | undefined

  export function register(value: Source | undefined): void {
    source = value
  }

  function requireSource(): Source {
    if (!source)
      throw new Error("Provider SDK source is not registered; compose a runtime or register a research SDK source")
    return source
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
