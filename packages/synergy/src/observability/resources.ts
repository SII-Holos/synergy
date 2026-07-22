import { ObservabilityClock } from "./clock"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilityContext } from "./context"
import { ObservabilityIssues } from "./issues"
import { ObservabilityMetrics } from "./metrics"
import { ObservabilitySchema } from "./schema"
import { ObservabilityStore } from "./store"
import { ObservabilityRedaction } from "./redaction"
import { ProcessRegistry } from "@/process/registry"
import { ServiceMemory } from "./service-memory"

export namespace ObservabilityResources {
  let timer: Timer | undefined
  let lastCpu = process.cpuUsage()
  let lastTime = performance.now()
  let eventLoopExpected = Date.now()
  let sampleIntervalMs: number | undefined
  const io = { appReadBytes: 0, appWrittenBytes: 0, appReadOps: 0, appWriteOps: 0 }
  const rssWindow: Array<{ time: number; rss: number }> = []

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
    const serviceMemory = ServiceMemory.sample({
      processMemory: memory,
      knownProcesses: childProcesses.map((child) => ({
        pid: child.pid,
        processId: child.id,
        rssBytes: child.rssBytes,
      })),
    })
    const mainProcess = serviceMemory.processes.find((item) => item.role === "main")
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
        pssBytes: mainProcess?.pssBytes,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      serviceMemory: serviceMemorySample(serviceMemory),
      eventLoop: { lagMs, sampleWindowMs: config.resourceSampleIntervalMs },
      io: { ...io, osAvailable: false },
      labels: {},
    })
    recordChildProcesses(now, config.resourceSampleIntervalMs, childProcesses, serviceMemory, sample.sampleId)
    ObservabilityStore.insertResource(sample)
    recordResourceMetrics(memory, serviceMemory, utilizationRatio, lagMs)
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
  }

  export function reconfigure() {
    stop()
    start()
  }

  function recordChildProcesses(
    now: number,
    sampleWindowMs: number,
    registered: ProcessRegistry.ResourceSnapshot[],
    serviceMemory: ServiceMemory.Snapshot,
    serviceSampleId: string,
  ) {
    const childProcesses = serviceMemory.processes.filter((item) => item.role === "child")
    const registeredByPid = new Map(
      registered.flatMap((item) => (item.pid === undefined ? [] : ([[item.pid, item]] as const))),
    )
    const registeredById = new Map(registered.map((item) => [item.id, item]))
    ObservabilityMetrics.record({
      name: "process.active.count",
      value: childProcesses.length,
      unit: "count",
      module: "process",
      source: "process",
      labels: { role: "tool-child" },
    })
    for (const child of childProcesses) {
      if (child.rssBytes === undefined && child.pssBytes === undefined) continue
      const known =
        (child.pid === undefined ? undefined : registeredByPid.get(child.pid)) ??
        (child.processId === undefined ? undefined : registeredById.get(child.processId))
      const commandFamily = known
        ? ObservabilityRedaction.commandFamily(known.command)
        : ObservabilityRedaction.text(child.name ?? "service-child", 64)
      const labels: Record<string, string | number | boolean> = {
        command: commandFamily,
        serviceSampleId,
        source: serviceMemory.source,
        registered: !!known,
      }
      if (known) {
        labels.backgrounded = known.backgrounded
        labels.ageMs = known.ageMs
        labels.outputChars = known.outputChars
        labels.truncated = known.truncated
      }
      ObservabilityStore.insertResource(
        ObservabilitySchema.ResourceSample.parse({
          sampleId: ObservabilityClock.id("res"),
          time: now,
          iso: ObservabilityClock.iso(now),
          source: "process",
          process: {
            pid: child.pid,
            processId: child.processId,
            role: known ? "tool" : "service-child",
          },
          memory: { rssBytes: child.rssBytes, pssBytes: child.pssBytes },
          eventLoop: { sampleWindowMs },
          io: { osAvailable: true },
          labels,
        }),
      )
      if (child.rssBytes !== undefined) {
        ObservabilityMetrics.record({
          name: "process.child.memory.rss",
          value: child.rssBytes,
          unit: "bytes",
          module: "process",
          source: "process",
          processId: child.processId,
          pid: child.pid,
          labels: { command: commandFamily, backgrounded: known?.backgrounded ?? false },
        })
      }
      if (child.pssBytes !== undefined) {
        ObservabilityMetrics.record({
          name: "process.child.memory.pss",
          value: child.pssBytes,
          unit: "bytes",
          module: "process",
          source: "process",
          processId: child.processId,
          pid: child.pid,
          labels: { command: commandFamily, backgrounded: known?.backgrounded ?? false },
        })
      }
    }
  }

  function recordResourceMetrics(
    memory: NodeJS.MemoryUsage,
    serviceMemory: ServiceMemory.Snapshot,
    utilizationRatio: number,
    lagMs: number,
  ) {
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
    recordServiceMemoryMetrics(serviceMemory)
  }

  function recordServiceMemoryMetrics(sample: ServiceMemory.Snapshot) {
    const metrics: Array<[string, number | undefined, "bytes" | "ratio" | "count"]> = [
      ["service.memory.current", sample.currentBytes, "bytes"],
      ["service.memory.peak", sample.peakBytes, "bytes"],
      ["service.memory.high", sample.highBytes, "bytes"],
      ["service.memory.max", sample.maxBytes, "bytes"],
      ["service.memory.usage_ratio", sample.usageRatio, "ratio"],
      ["service.memory.swap", sample.swapBytes, "bytes"],
      ["service.memory.anon", sample.anonBytes, "bytes"],
      ["service.memory.file", sample.fileBytes, "bytes"],
      ["service.memory.kernel", sample.kernelBytes, "bytes"],
      ["service.memory.slab", sample.slabBytes, "bytes"],
      ["service.process.rss", sample.processRssBytes, "bytes"],
      ["service.process.pss", sample.processPssBytes, "bytes"],
      ["service.memory.events.high", sample.events.high, "count"],
      ["service.memory.events.max", sample.events.max, "count"],
      ["service.memory.events.oom", sample.events.oom, "count"],
      ["service.memory.events.oom_kill", sample.events.oomKill, "count"],
    ]
    for (const [name, value, unit] of metrics) {
      if (value === undefined) continue
      ObservabilityMetrics.record({
        name,
        value,
        unit,
        module: "process",
        source: "process",
        labels: { source: sample.source },
      })
    }
  }

  function serviceMemorySample(sample: ServiceMemory.Snapshot): ObservabilitySchema.ServiceMemory {
    const { processes: _, ...summary } = sample
    return ObservabilitySchema.ServiceMemory.parse(summary)
  }

  function detectPressure(
    sample: ObservabilitySchema.ResourceSample,
    config: ReturnType<typeof ObservabilityConfig.current>,
  ) {
    const rss = sample.memory.rssBytes ?? 0
    const heapUsed = sample.memory.heapUsedBytes ?? 0
    const heapTotal = sample.memory.heapTotalBytes ?? 0
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
      heapTotal > 0 &&
      heapUsed / heapTotal >=
        (config.thresholds.highHeapUsedRatio ?? ObservabilityConfig.defaults.thresholds.highHeapUsedRatio)
    ) {
      ObservabilityIssues.raise({
        code: "PERF_MEMORY_HIGH_HEAP_RATIO",
        severity: "warning",
        module: "process",
        title: "High heap usage ratio",
        message: `Heap usage ratio is ${(heapUsed / heapTotal).toFixed(2)}`,
        recommendation: "Inspect memory trend and active sessions/tools before restarting the server.",
        evidence: { heapUsedBytes: heapUsed, heapTotalBytes: heapTotal, ratio: heapUsed / heapTotal },
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
