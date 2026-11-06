import { RuntimeContext } from "../lifecycle/context"
import type { Scope } from "../scope"

export namespace ConfigSource {
  export interface Source {
    resolve(input: Readonly<{ scope: Scope }>): Promise<unknown>
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))
  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("configuration source")
    if (state().source) throw new Error("Configuration source is already registered")
    state().source = source
  }
  export function get() {
    return state().source
  }
}
