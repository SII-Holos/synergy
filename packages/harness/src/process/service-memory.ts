import { ResourceHost } from "../resources/host"
import { RuntimeContext } from "../lifecycle/context"

export namespace ServiceMemory {
  export type Source = "cgroup_v2" | "process_sum"
  export type Coverage = "cgroup" | "registered_processes"

  export type CgroupV2 = {
    currentBytes?: number
    highBytes?: number
    maxBytes?: number
    peakBytes?: number
    swapCurrentBytes?: number
    stat?: {
      anonBytes?: number
      fileBytes?: number
      kernelBytes?: number
      slabBytes?: number
      activeFileBytes?: number
      inactiveFileBytes?: number
      slabReclaimableBytes?: number
      slabUnreclaimableBytes?: number
      reclaimableBytes?: number
      workingSetBytes?: number
    }
    events?: {
      low?: number
      high?: number
      max?: number
      oom?: number
      oomKill?: number
      oomGroupKill?: number
    }
    pressure?: {
      some?: Pressure
      full?: Pressure
    }
  }

  export type Pressure = {
    avg10?: number
    avg60?: number
    avg300?: number
    totalMicros?: number
  }

  export type Measurement = {
    currentBytes: number
    source: Source
    coverage: Coverage
    complete: boolean
    childProcessCount: number
    measuredChildProcessCount: number
    childProcessRssBytes: number
  }

  export function currentCgroupV2(): CgroupV2 | undefined {
    return RuntimeContext.tryCurrent() ? ResourceHost.get()?.serviceMemory?.() : undefined
  }

  export function measure(input: {
    processRssBytes: number
    children: Array<{ rssBytes?: number }>
    cgroup?: CgroupV2
  }): Measurement {
    const measured = input.children.filter(
      (child): child is { rssBytes: number } => child.rssBytes !== undefined && Number.isFinite(child.rssBytes),
    )
    const childProcessRssBytes = measured.reduce((sum, child) => sum + child.rssBytes, 0)
    const common = {
      childProcessCount: input.children.length,
      measuredChildProcessCount: measured.length,
      childProcessRssBytes,
    }
    if (input.cgroup?.currentBytes !== undefined) {
      return {
        currentBytes: input.cgroup.currentBytes,
        source: "cgroup_v2",
        coverage: "cgroup",
        complete: true,
        ...common,
      }
    }
    return {
      currentBytes: input.processRssBytes + childProcessRssBytes,
      source: "process_sum",
      coverage: "registered_processes",
      complete: false,
      ...common,
    }
  }
}
