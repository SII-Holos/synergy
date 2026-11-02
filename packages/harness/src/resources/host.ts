import { RuntimeContext } from "../lifecycle/context"
import type { ResourceSnapshot } from "./schema"

export namespace ResourceHost {
  export interface Source {
    sample(): Promise<ResourceSnapshot>
    observe?(changed: () => void): () => void
    close?(): void
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("resource sampler")
    if (state().source) throw new Error("Resource sampler is already registered")
    state().source = source
  }

  export function get() {
    return state().source
  }
}
