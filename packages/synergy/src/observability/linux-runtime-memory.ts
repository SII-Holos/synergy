import { heapStats } from "bun:jsc"

export namespace LinuxRuntimeMemory {
  const DEFAULT_INTERVAL_MS = 60_000
  const TOP_TYPE_LIMIT = 12
  let lastSampleAt = 0
  let last: Snapshot | undefined
  let previousTypeCounts = new Map<string, number>()

  export interface ObjectTypeCount {
    type: string
    count: number
    delta: number
  }

  export interface Snapshot {
    sampledAt: number
    jscHeapSizeBytes: number
    jscHeapCapacityBytes: number
    jscExtraMemoryBytes: number
    objectCount: number
    protectedObjectCount: number
    allocatorRssBytes?: number
    allocatorCommittedBytes?: number
    allocatorReservedBytes?: number
    allocatorAbandonedPages?: number
    topObjectTypes: ObjectTypeCount[]
    growingObjectTypes: ObjectTypeCount[]
  }

  interface HeapStatsSnapshot {
    heapSize: number
    heapCapacity: number
    extraMemorySize: number
    objectCount: number
    protectedObjectCount: number
    objectTypeCounts: Record<string, number>
    mimalloc?: {
      process?: { rss_current?: number }
      committed?: { current?: number }
      reserved?: { current?: number }
      pages_abandoned?: { current?: number }
    }
  }

  export function sample(
    input: {
      now?: number
      force?: boolean
      env?: NodeJS.ProcessEnv
      platform?: NodeJS.Platform
      readStats?: () => HeapStatsSnapshot
    } = {},
  ): Snapshot | undefined {
    if ((input.platform ?? process.platform) !== "linux") return
    const now = input.now ?? Date.now()
    const interval = envNumber(input.env?.SYNERGY_LINUX_HEAP_STATS_INTERVAL_MS) ?? DEFAULT_INTERVAL_MS
    if (!input.force && last && now - lastSampleAt < interval) return last

    try {
      const stats = input.readStats?.() ?? (heapStats() as HeapStatsSnapshot)
      const counts = new Map(Object.entries(stats.objectTypeCounts).map(([type, count]) => [type, Number(count)]))
      const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      const growth = ranked
        .map(([type, count]) => ({ type, count, delta: count - (previousTypeCounts.get(type) ?? 0) }))
        .filter((item) => item.delta > 0)
        .sort((a, b) => b.delta - a.delta || b.count - a.count || a.type.localeCompare(b.type))
      const mimalloc = stats.mimalloc
      last = {
        sampledAt: now,
        jscHeapSizeBytes: finite(stats.heapSize),
        jscHeapCapacityBytes: finite(stats.heapCapacity),
        jscExtraMemoryBytes: finite(stats.extraMemorySize),
        objectCount: finite(stats.objectCount),
        protectedObjectCount: finite(stats.protectedObjectCount),
        allocatorRssBytes: optionalFinite(mimalloc?.process?.rss_current),
        allocatorCommittedBytes: optionalFinite(mimalloc?.committed?.current),
        allocatorReservedBytes: optionalFinite(mimalloc?.reserved?.current),
        allocatorAbandonedPages: optionalFinite(mimalloc?.pages_abandoned?.current),
        topObjectTypes: ranked.slice(0, TOP_TYPE_LIMIT).map(([type, count]) => ({
          type,
          count,
          delta: count - (previousTypeCounts.get(type) ?? 0),
        })),
        growingObjectTypes: growth.slice(0, TOP_TYPE_LIMIT),
      }
      previousTypeCounts = counts
      lastSampleAt = now
      return last
    } catch {
      return last
    }
  }

  export function resetForTest() {
    lastSampleAt = 0
    last = undefined
    previousTypeCounts = new Map()
  }

  function envNumber(value: string | undefined) {
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }

  function finite(value: number) {
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  function optionalFinite(value: number | undefined) {
    return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
  }
}
