import { RuntimeContext } from "../lifecycle/context"
import type { ResourceSnapshot } from "./schema"
import type { ServiceMemory } from "../process/service-memory"

export namespace ResourceHost {
  export interface Source {
    sample(): Promise<ResourceSnapshot>
    serviceMemory?(): ServiceMemory.CgroupV2 | undefined
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
