import { RuntimeContext } from "../lifecycle/context"
import type { ServiceMemory } from "../process/service-memory"

export namespace ServiceMemoryMetrics {
  const DEFAULT_DETAIL_INTERVAL_MS = 60_000
  const MIN_DETAIL_INTERVAL_MS = 30_000
  const DEFAULT_STATIC_HEARTBEAT_MS = 5 * 60_000

  export type Metric = {
    name: string
    value: number
    unit: "bytes" | "count" | "percent" | "microseconds"
  }

  const runtimeState = RuntimeContext.state(() => ({
    lastDetailAt: undefined as number | undefined,
    previousEvents: undefined as ServiceMemory.CgroupV2["events"],
    previousPressureTotals: undefined as { some?: number; full?: number } | undefined,
    staticMetrics: new Map<string, { value: number; emittedAt: number }>(),
  }))

  export function plan(input: { now: number; cgroup: ServiceMemory.CgroupV2; env?: NodeJS.ProcessEnv }): Metric[] {
    const instanceState = runtimeState()

    const rows: Metric[] = []
    add(rows, "service.memory.current", input.cgroup.currentBytes, "bytes")

    const heartbeatMs = Math.max(
      MIN_DETAIL_INTERVAL_MS,
      envNumber(input.env?.SYNERGY_CGROUP_STATIC_HEARTBEAT_MS) ?? DEFAULT_STATIC_HEARTBEAT_MS,
    )
    addStatic(rows, "service.memory.high", input.cgroup.highBytes, input.now, heartbeatMs)
    addStatic(rows, "service.memory.max", input.cgroup.maxBytes, input.now, heartbeatMs)

    const detailIntervalMs = Math.min(
      DEFAULT_DETAIL_INTERVAL_MS,
      Math.max(
        MIN_DETAIL_INTERVAL_MS,
        envNumber(input.env?.SYNERGY_CGROUP_DETAIL_INTERVAL_MS) ?? DEFAULT_DETAIL_INTERVAL_MS,
      ),
    )
    if (instanceState.lastDetailAt === undefined || input.now - instanceState.lastDetailAt >= detailIntervalMs) {
      instanceState.lastDetailAt = input.now
      recordDetails(rows, input.cgroup)
    }

    recordDeltas(rows, input.cgroup)
    return rows
  }

  export function reset() {
    const instanceState = runtimeState()

    instanceState.lastDetailAt = undefined
    instanceState.previousEvents = undefined
    instanceState.previousPressureTotals = undefined
    instanceState.staticMetrics.clear()
  }

  export const resetForTest = reset

  function recordDetails(rows: Metric[], cgroup: ServiceMemory.CgroupV2) {
    const bytes: Record<string, number | undefined> = {
      "service.memory.peak": cgroup.peakBytes,
      "service.memory.swap": cgroup.swapCurrentBytes,
      "service.memory.anon": cgroup.stat?.anonBytes,
      "service.memory.file": cgroup.stat?.fileBytes,
      "service.memory.kernel": cgroup.stat?.kernelBytes,
      "service.memory.slab": cgroup.stat?.slabBytes,
      "service.memory.file.active": cgroup.stat?.activeFileBytes,
      "service.memory.file.inactive": cgroup.stat?.inactiveFileBytes,
      "service.memory.slab.reclaimable": cgroup.stat?.slabReclaimableBytes,
      "service.memory.slab.unreclaimable": cgroup.stat?.slabUnreclaimableBytes,
      "service.memory.reclaimable": cgroup.stat?.reclaimableBytes,
      "service.memory.working_set": cgroup.stat?.workingSetBytes,
    }
    for (const [name, value] of Object.entries(bytes)) add(rows, name, value, "bytes")

    const events: Record<string, number | undefined> = {
      "service.memory.events.low": cgroup.events?.low,
      "service.memory.events.high": cgroup.events?.high,
      "service.memory.events.max": cgroup.events?.max,
      "service.memory.events.oom": cgroup.events?.oom,
      "service.memory.events.oom_kill": cgroup.events?.oomKill,
      "service.memory.events.oom_group_kill": cgroup.events?.oomGroupKill,
    }
    for (const [name, value] of Object.entries(events)) add(rows, name, value, "count")

    const pressure: Record<string, number | undefined> = {
      "service.memory.pressure.some.avg10": cgroup.pressure?.some?.avg10,
      "service.memory.pressure.some.avg60": cgroup.pressure?.some?.avg60,
      "service.memory.pressure.some.avg300": cgroup.pressure?.some?.avg300,
      "service.memory.pressure.full.avg10": cgroup.pressure?.full?.avg10,
      "service.memory.pressure.full.avg60": cgroup.pressure?.full?.avg60,
      "service.memory.pressure.full.avg300": cgroup.pressure?.full?.avg300,
    }
    for (const [name, value] of Object.entries(pressure)) add(rows, name, value, "percent")
  }

  function recordDeltas(rows: Metric[], cgroup: ServiceMemory.CgroupV2) {
    const instanceState = runtimeState()

    if (instanceState.previousEvents && cgroup.events) {
      const events: Record<string, number | undefined> = {
        "service.memory.events.low.delta": counterDelta(cgroup.events.low, instanceState.previousEvents.low),
        "service.memory.events.high.delta": counterDelta(cgroup.events.high, instanceState.previousEvents.high),
        "service.memory.events.max.delta": counterDelta(cgroup.events.max, instanceState.previousEvents.max),
        "service.memory.events.oom.delta": counterDelta(cgroup.events.oom, instanceState.previousEvents.oom),
        "service.memory.events.oom_kill.delta": counterDelta(
          cgroup.events.oomKill,
          instanceState.previousEvents.oomKill,
        ),
        "service.memory.events.oom_group_kill.delta": counterDelta(
          cgroup.events.oomGroupKill,
          instanceState.previousEvents.oomGroupKill,
        ),
      }
      for (const [name, value] of Object.entries(events)) {
        if (value !== undefined && value > 0) rows.push({ name, value, unit: "count" })
      }
    }
    instanceState.previousEvents = cgroup.events ? { ...cgroup.events } : undefined

    const pressureTotals = {
      some: cgroup.pressure?.some?.totalMicros,
      full: cgroup.pressure?.full?.totalMicros,
    }
    if (instanceState.previousPressureTotals) {
      const pressure: Record<string, number | undefined> = {
        "service.memory.pressure.some.stall_delta": counterDelta(
          pressureTotals.some,
          instanceState.previousPressureTotals.some,
        ),
        "service.memory.pressure.full.stall_delta": counterDelta(
          pressureTotals.full,
          instanceState.previousPressureTotals.full,
        ),
      }
      for (const [name, value] of Object.entries(pressure)) {
        if (value !== undefined && value > 0) rows.push({ name, value, unit: "microseconds" })
      }
    }
    instanceState.previousPressureTotals = pressureTotals
  }

  function addStatic(rows: Metric[], name: string, value: number | undefined, now: number, heartbeatMs: number) {
    const instanceState = runtimeState()

    if (value === undefined || !Number.isFinite(value)) {
      instanceState.staticMetrics.delete(name)
      return
    }
    const previous = instanceState.staticMetrics.get(name)
    if (previous && previous.value === value && now - previous.emittedAt < heartbeatMs) return
    rows.push({ name, value, unit: "bytes" })
    instanceState.staticMetrics.set(name, { value, emittedAt: now })
  }

  function add(rows: Metric[], name: string, value: number | undefined, unit: Metric["unit"]) {
    if (value === undefined || !Number.isFinite(value)) return
    rows.push({ name, value, unit })
  }

  function counterDelta(current: number | undefined, previous: number | undefined) {
    if (current === undefined || previous === undefined) return undefined
    return current >= previous ? current - previous : current
  }

  function envNumber(value: string | undefined) {
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
}
