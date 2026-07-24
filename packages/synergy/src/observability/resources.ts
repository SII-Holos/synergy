import { ObservabilityClock } from "./clock"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilityContext } from "./context"
import { ObservabilityIssues } from "./issues"
import { ObservabilityMetrics } from "./metrics"
import { ObservabilitySchema } from "./schema"
import { ObservabilityStore } from "./store"
import { ObservabilityRedaction } from "./redaction"
import { ProcessRegistry } from "@/process/registry"
import { ProcessMemory } from "@/process/memory-usage"
import { ServiceMemory } from "@/process/service-memory"
import { LinuxRuntimeMemory } from "./linux-runtime-memory"
import { ServiceMemoryMetrics } from "./service-memory-metrics"

type PublicServiceMemory = NonNullable<ObservabilitySchema.ResourceSample["serviceMemory"]>

const serviceMemorySources = {
  cgroup_v2: "cgroup_v2",
  process_sum: "process_api",
} satisfies Record<ServiceMemory.Source, PublicServiceMemory["source"]>

function serviceMemoryCompleteness(complete: boolean): PublicServiceMemory["completeness"] {
  return complete ? "full" : "partial"
}

export namespace ObservabilityResources {
  let timer: Timer | undefined
  let lastCpu = process.cpuUsage()
  let lastTime = performance.now()
  let eventLoopExpected = Date.now()
  let sampleIntervalMs: number | undefined
  const io = { appReadBytes: 0, appWrittenBytes: 0, appReadOps: 0, appWriteOps: 0 }
  const rssWindow: Array<{ time: number; rss: number }> = []
  let lastRuntimeMetricSampleAt = 0

  export function addRead(bytes: number) {
    io.appReadBytes += Math.max(0, bytes)
    io.appReadOps += 1
  }

  export function stats() {
    return { running: !!timer, sampleIntervalMs }
  }

  export function addWrite(bytes: number) {
    io.appWrittenBytes += Math.max(0, bytes)
    io.appWriteOps += 1
  }

  export function snapshot(
    input: { role?: ObservabilitySchema.ResourceSample["process"]["role"]; processId?: string; pid?: number } = {},
  ) {
    const config = ObservabilityConfig.current()
    if (!config.enabled) return
    const ctx = ObservabilityContext.current()
    const now = ObservabilityClock.now()
    const memory = process.memoryUsage()
    const childProcesses = ProcessRegistry.resourceSnapshot({ now, settleStale: true })
    const cgroup = ServiceMemory.currentCgroupV2()
    const serviceMemory = ServiceMemory.measure({ processRssBytes: memory.rss, children: childProcesses, cgroup })
    const cpu = process.cpuUsage()
    const elapsedMs = Math.max(1, performance.now() - lastTime)
    const userDelta = cpu.user - lastCpu.user
    const systemDelta = cpu.system - lastCpu.system
    const utilizationRatio = Math.min(1, Math.max(0, (userDelta + systemDelta) / (elapsedMs * 1000)))
    const lagMs = Math.max(0, Date.now() - eventLoopExpected)
    eventLoopExpected = Date.now() + config.resourceSampleIntervalMs
    lastCpu = cpu
    lastTime = performance.now()
    const sample = ObservabilitySchema.ResourceSample.parse({
      sampleId: ObservabilityClock.id("res"),
      time: now,
      iso: ObservabilityClock.iso(now),
      source: "process",
      correlationId: ctx.correlationId,
      traceId: ctx.traceId,
      scopeID: ctx.scopeID,
      sessionID: ctx.sessionID,
      process: {
        pid: input.pid ?? process.pid,
        processId: input.processId ?? ctx.processId,
        role: input.role ?? "server",
      },
      cpu: { userMicros: cpu.user, systemMicros: cpu.system, utilizationRatio },
      memory: {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      cgroup: cgroup
        ? {
            currentBytes: cgroup.currentBytes,
            highBytes: cgroup.highBytes,
            maxBytes: cgroup.maxBytes,
            peakBytes: cgroup.peakBytes,
            oomCount: cgroup.events?.oom,
            oomKillCount: cgroup.events?.oomKill,
          }
        : undefined,
      serviceMemory: {
        rssBytes: serviceMemory.currentBytes,
        source: serviceMemorySources[serviceMemory.source],
        completeness: serviceMemoryCompleteness(serviceMemory.complete),
      },
      eventLoop: { lagMs, sampleWindowMs: config.resourceSampleIntervalMs },
      io: { ...io, osAvailable: false },
      labels: {},
    })
    ObservabilityStore.insertResource(sample)
    recordChildProcesses(now, config.resourceSampleIntervalMs, childProcesses)
    recordResourceMetrics(memory, utilizationRatio, lagMs)
    recordServiceMemoryMetrics(cgroup, now)
    recordLinuxRuntimeMetrics()
    detectPressure(sample, config)
  }

  export function start() {
    if (timer) return
    const config = ObservabilityConfig.current()
    if (!config.enabled) return
    sampleIntervalMs = config.resourceSampleIntervalMs
    eventLoopExpected = Date.now() + config.resourceSampleIntervalMs
    timer = setInterval(snapshot, config.resourceSampleIntervalMs)
    timer.unref()
  }

  export function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
    sampleIntervalMs = undefined
    ServiceMemoryMetrics.reset()
  }

  export function reconfigure() {
    stop()
    start()
  }

  function recordChildProcesses(
    now: number,
    sampleWindowMs: number,
    childProcesses: ReturnType<typeof ProcessRegistry.resourceSnapshot>,
  ) {
    ObservabilityMetrics.record({
      name: "process.active.count",
      value: childProcesses.length,
      unit: "count",
      module: "process",
      source: "process",
      labels: { role: "tool-child" },
    })
    for (const child of childProcesses) {
      const commandFamily = ObservabilityRedaction.commandFamily(child.command)
      const labels: Record<string, string | number | boolean> = {
        command: commandFamily,
        backgrounded: child.backgrounded,
        ageMs: child.ageMs,
        outputChars: child.outputChars,
        truncated: child.truncated,
      }
      ObservabilityStore.insertResource(
        ObservabilitySchema.ResourceSample.parse({
          sampleId: ObservabilityClock.id("res"),
          time: now,
          iso: ObservabilityClock.iso(now),
          source: "process",
          process: { pid: child.pid, processId: child.id, role: "tool" },
          memory: { rssBytes: child.rssBytes },
          eventLoop: { sampleWindowMs },
          io: { osAvailable: true },
          labels,
        }),
      )
      if (child.rssBytes === undefined) continue
      ObservabilityMetrics.record({
        name: "process.child.memory.rss",
        value: child.rssBytes,
        unit: "bytes",
        module: "process",
        source: "process",
        processId: child.id,
        pid: child.pid,
        labels: { command: commandFamily, backgrounded: child.backgrounded },
      })
    }
  }

  function recordResourceMetrics(memory: NodeJS.MemoryUsage, utilizationRatio: number, lagMs: number) {
    ObservabilityMetrics.record({
      name: "process.memory.rss",
      value: memory.rss,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    ObservabilityMetrics.record({
      name: "process.memory.heap_used",
      value: memory.heapUsed,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    ObservabilityMetrics.record({
      name: "process.memory.heap_total",
      value: memory.heapTotal,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    ObservabilityMetrics.record({
      name: "process.cpu.utilization",
      value: utilizationRatio,
      unit: "ratio",
      module: "process",
      source: "process",
    })
    ObservabilityMetrics.record({
      name: "process.event_loop.lag",
      value: lagMs,
      unit: "ms",
      module: "process",
      source: "process",
    })
    ObservabilityMetrics.record({
      name: "process.memory.external",
      value: memory.external,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    ObservabilityMetrics.record({
      name: "process.memory.array_buffers",
      value: memory.arrayBuffers,
      unit: "bytes",
      module: "process",
      source: "process",
    })
  }

  function recordServiceMemoryMetrics(cgroup: ServiceMemory.CgroupV2 | undefined, now: number) {
    if (!cgroup) return
    const labels = { source: "cgroup_v2", platform: "linux" }
    for (const metric of ServiceMemoryMetrics.plan({ now, cgroup, env: process.env })) {
      ObservabilityMetrics.record({
        ...metric,
        module: "process",
        source: "process",
        labels,
      })
    }
  }

  function recordLinuxRuntimeMetrics() {
    const runtime = LinuxRuntimeMemory.sample()
    if (!runtime || runtime.sampledAt === lastRuntimeMetricSampleAt) return
    lastRuntimeMetricSampleAt = runtime.sampledAt
    const labels = { platform: "linux" }
    recordOptionalMetrics(
      {
        "runtime.jsc.heap_size": runtime.jscHeapSizeBytes,
        "runtime.jsc.heap_capacity": runtime.jscHeapCapacityBytes,
        "runtime.jsc.extra_memory": runtime.jscExtraMemoryBytes,
        "runtime.allocator.rss": runtime.allocatorRssBytes,
        "runtime.allocator.committed": runtime.allocatorCommittedBytes,
        "runtime.allocator.reserved": runtime.allocatorReservedBytes,
      },
      "bytes",
      labels,
    )
    recordOptionalMetrics(
      {
        "runtime.jsc.object_count": runtime.objectCount,
        "runtime.jsc.protected_object_count": runtime.protectedObjectCount,
        "runtime.allocator.abandoned_pages": runtime.allocatorAbandonedPages,
      },
      "count",
      labels,
    )
    for (const item of runtime.topObjectTypes) {
      ObservabilityMetrics.record({
        name: "runtime.jsc.object_type.count",
        value: item.count,
        unit: "count",
        module: "process",
        source: "process",
        labels: { ...labels, objectType: item.type },
      })
    }
    for (const item of runtime.growingObjectTypes) {
      ObservabilityMetrics.record({
        name: "runtime.jsc.object_type.growth",
        value: item.delta,
        unit: "count",
        module: "process",
        source: "process",
        labels: { ...labels, objectType: item.type },
      })
    }
  }

  function recordOptionalMetrics(
    values: Record<string, number | undefined>,
    unit: ObservabilitySchema.Unit,
    labels: Record<string, string>,
  ) {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined || !Number.isFinite(value)) continue
      ObservabilityMetrics.record({
        name,
        value,
        unit,
        module: "process",
        source: "process",
        labels,
      })
    }
  }

  function detectPressure(
    sample: ObservabilitySchema.ResourceSample,
    config: ReturnType<typeof ObservabilityConfig.current>,
  ) {
    const rss = sample.memory.rssBytes ?? 0
    const heapRatio = ProcessMemory.heapUsageRatio({
      heapUsedBytes: sample.memory.heapUsedBytes,
      heapTotalBytes: sample.memory.heapTotalBytes,
    })
    const cpu = sample.cpu.utilizationRatio ?? 0
    const lag = sample.eventLoop.lagMs ?? 0
    rssWindow.push({ time: sample.time, rss })
    while (rssWindow.length > 0 && sample.time - rssWindow[0].time > 2 * 60 * 60 * 1000) rssWindow.shift()
    const first = rssWindow[0]
    const rssGrowthBytesPerMin =
      first && sample.time > first.time ? ((rss - first.rss) / Math.max(1, sample.time - first.time)) * 60_000 : 0
    if (rss >= (config.thresholds.highRssBytes ?? ObservabilityConfig.defaults.thresholds.highRssBytes)) {
      ObservabilityIssues.raise({
        code: "PERF_MEMORY_HIGH_RSS",
        severity: "warning",
        module: "process",
        title: "High RSS memory usage",
        message: `Process RSS is ${rss} bytes`,
        recommendation: "Inspect resource trends and inflight operations to identify the owning process or tool.",
        evidence: {
          observedValue: rss,
          thresholdValue: config.thresholds.highRssBytes ?? null,
          rssGrowthBytesPerMin,
          unit: "bytes",
        },
      })
    }
    if (
      heapRatio.available &&
      heapRatio.ratio >=
        (config.thresholds.highHeapUsedRatio ?? ObservabilityConfig.defaults.thresholds.highHeapUsedRatio)
    ) {
      ObservabilityIssues.raise({
        code: "PERF_MEMORY_HIGH_HEAP_RATIO",
        severity: "warning",
        module: "process",
        title: "High heap usage ratio",
        message: `Heap usage ratio is ${heapRatio.ratio.toFixed(2)}`,
        recommendation: "Inspect memory trend and active sessions/tools before restarting the server.",
        evidence: {
          heapUsedBytes: sample.memory.heapUsedBytes ?? null,
          heapTotalBytes: sample.memory.heapTotalBytes ?? null,
          ratio: heapRatio.ratio,
        },
      })
    }
    if (
      cpu >=
      (config.thresholds.highCpuUtilizationRatio ?? ObservabilityConfig.defaults.thresholds.highCpuUtilizationRatio)
    ) {
      ObservabilityIssues.raise({
        code: "PERF_CPU_HIGH_UTILIZATION",
        severity: "warning",
        module: "process",
        title: "High CPU utilization",
        message: `Process CPU utilization is ${cpu}`,
        recommendation: "Compare this sample with inflight spans and process registry entries.",
        evidence: {
          observedValue: cpu,
          thresholdValue: config.thresholds.highCpuUtilizationRatio ?? null,
          unit: "ratio",
        },
      })
    }
    if (lag >= (config.thresholds.eventLoopLagMs ?? ObservabilityConfig.defaults.thresholds.eventLoopLagMs)) {
      ObservabilityIssues.raise({
        code: "PERF_EVENT_LOOP_LAG",
        severity: "warning",
        module: "process",
        title: "Event loop lag detected",
        message: `Event loop lag is ${Math.round(lag)}ms`,
        recommendation: "Inspect CPU-heavy spans and recent process/tool output around the same timestamp.",
        evidence: { observedValue: lag, thresholdValue: config.thresholds.eventLoopLagMs ?? null, unit: "ms" },
      })
    }
    const external = sample.memory.externalBytes ?? 0
    const highExternalThreshold =
      config.thresholds.highExternalBytes ?? ObservabilityConfig.defaults.thresholds.highExternalBytes
    if (external >= highExternalThreshold) {
      ObservabilityIssues.raise({
        code: "PERF_MEMORY_HIGH_EXTERNAL",
        severity: "warning",
        module: "process",
        title: "High external memory usage",
        message: `Process external memory is ${external} bytes`,
        evidence: { observedValue: external, thresholdValue: highExternalThreshold, unit: "bytes" },
      })
    }
    const arrayBuffers = sample.memory.arrayBuffersBytes ?? 0
    const highArrayBuffersThreshold =
      config.thresholds.highArrayBuffersBytes ?? ObservabilityConfig.defaults.thresholds.highArrayBuffersBytes
    if (arrayBuffers >= highArrayBuffersThreshold) {
      ObservabilityIssues.raise({
        code: "PERF_MEMORY_HIGH_ARRAY_BUFFERS",
        severity: "warning",
        module: "process",
        title: "High ArrayBuffers memory usage",
        message: `Process ArrayBuffers memory is ${arrayBuffers} bytes`,
        evidence: { observedValue: arrayBuffers, thresholdValue: highArrayBuffersThreshold, unit: "bytes" },
      })
    }
  }
}
