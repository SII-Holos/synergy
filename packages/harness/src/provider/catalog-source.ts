import { RuntimeContext } from "../lifecycle/context"
import type { Provider } from "./provider"

export namespace ProviderCatalogSource {
  export interface Source {
    providers(): Promise<Record<string, Provider.Info>>
  }

  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("provider catalog source")
    if (state().source) throw new Error("Provider catalog source is already registered")
    state().source = source
  }

  export function get() {
    return state().source
  }
}
