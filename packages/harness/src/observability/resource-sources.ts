import { RuntimeContext } from "../lifecycle/context"

export namespace ResourceSources {
  export interface Snapshot {
    owner: "plugin" | "browser" | "mcp"
    processCount: number
    measuredProcessCount: number
    currentBytes?: number
    peakBytes?: number
    baselineBytes?: number
    retainedBytes?: number
    heapUsedBytes?: number
    externalBytes?: number
    arrayBuffersBytes?: number
    source: "plugin_monitor" | "browser_runtime" | "mcp_stdio"
    completeness: "full" | "partial" | "unavailable"
    attributes: Record<string, string | number | boolean>
    lastRecovery?: {
      action: "gc" | "recycle" | "idle_retire" | "close"
      reason: string
      at: number
      beforeBytes?: number
      afterBytes?: number
      reclaimedBytes?: number
      timedOut?: boolean
    }
  }
  type Source = () => Snapshot | Promise<Snapshot>
  const state = RuntimeContext.state(() => new Map<string, Source>())

  export function register(owner: string, source: Source) {
    if (state().get(owner) === source) return
    RuntimeContext.assertCompositionOpen("resource statistics sources")
    if (state().has(owner)) throw new Error(`Duplicate resource source: ${owner}`)
    state().set(owner, source)
  }

  export async function read(): Promise<Snapshot[]> {
    return Promise.all([...state().values()].map((source) => source()))
  }
}
