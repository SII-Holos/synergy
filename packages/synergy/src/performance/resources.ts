import { PerformanceClock } from "./clock"
import { PerformanceConfig } from "./config"
import { PerformanceIssues } from "./issues"
import { PerformanceMetrics } from "./metrics"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"
import { ProcessRegistry } from "@/process/registry"

export namespace PerformanceResources {
  let timer: Timer | undefined
  let lastCpu = process.cpuUsage()
  let lastTime = performance.now()
  let eventLoopExpected = Date.now()
  const io = { appReadBytes: 0, appWrittenBytes: 0, appReadOps: 0, appWriteOps: 0 }

  export function addRead(bytes: number) {
    io.appReadBytes += Math.max(0, bytes)
    io.appReadOps += 1
  }

  export function addWrite(bytes: number) {
    io.appWrittenBytes += Math.max(0, bytes)
    io.appWriteOps += 1
  }

  export function snapshot() {
    const config = PerformanceConfig.current()
    if (!config.enabled) return
    const now = PerformanceClock.now()
    const memory = process.memoryUsage()
    const cpu = process.cpuUsage()
    const elapsedMs = Math.max(1, performance.now() - lastTime)
    const userDelta = cpu.user - lastCpu.user
    const systemDelta = cpu.system - lastCpu.system
    const utilizationRatio = Math.min(1, Math.max(0, (userDelta + systemDelta) / (elapsedMs * 1000)))
    const lagMs = Math.max(0, Date.now() - eventLoopExpected)
    eventLoopExpected = Date.now() + config.resourceSampleIntervalMs
    lastCpu = cpu
    lastTime = performance.now()
    const sample = PerformanceSchema.ResourceSample.parse({
      sampleId: PerformanceClock.id("res"),
      time: now,
      iso: PerformanceClock.iso(now),
      source: "process",
      process: { pid: process.pid, role: "server" },
      cpu: { userMicros: cpu.user, systemMicros: cpu.system, utilizationRatio },
      memory: {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      eventLoop: { lagMs, sampleWindowMs: config.resourceSampleIntervalMs },
      io: { ...io, osAvailable: false },
      labels: {},
    })
    PerformanceStore.insertResource(sample)
    const childProcesses = ProcessRegistry.resourceSnapshot({ now, settleStale: true })
    PerformanceMetrics.record({
      name: "process.active.count",
      value: childProcesses.length,
      unit: "count",
      module: "process",
      source: "process",
      labels: { role: "tool-child" },
    })
    for (const child of childProcesses) {
      if (child.rssBytes === undefined) continue
      const labels: Record<string, string | number | boolean> = {
        command: truncateLabel(child.command),
        backgrounded: child.backgrounded,
        ageMs: child.ageMs,
        outputChars: child.outputChars,
        truncated: child.truncated,
      }
      if (child.description) labels.description = truncateLabel(child.description)
      const childSample = PerformanceSchema.ResourceSample.parse({
        sampleId: PerformanceClock.id("res"),
        time: now,
        iso: PerformanceClock.iso(now),
        source: "process",
        process: {
          pid: child.pid,
          processId: child.id,
          role: child.backgrounded ? "tool-background" : "tool",
        },
        memory: { rssBytes: child.rssBytes },
        eventLoop: { sampleWindowMs: config.resourceSampleIntervalMs },
        io: { osAvailable: true },
        labels,
      })
      PerformanceStore.insertResource(childSample)
      PerformanceMetrics.record({
        name: "process.child.memory.rss",
        value: child.rssBytes,
        unit: "bytes",
        module: "process",
        source: "process",
        processId: child.id,
        pid: child.pid,
        labels: {
          command: truncateLabel(child.command),
          backgrounded: child.backgrounded,
        },
      })
    }
    PerformanceMetrics.record({
      name: "process.memory.rss",
      value: memory.rss,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    PerformanceMetrics.record({
      name: "process.memory.heap_used",
      value: memory.heapUsed,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    PerformanceMetrics.record({
      name: "process.memory.heap_total",
      value: memory.heapTotal,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    PerformanceMetrics.record({
      name: "process.cpu.utilization",
      value: utilizationRatio,
      unit: "ratio",
      module: "process",
      source: "process",
    })
    PerformanceMetrics.record({
      name: "process.event_loop.lag",
      value: lagMs,
      unit: "ms",
      module: "process",
      source: "process",
    })
    PerformanceMetrics.record({
      name: "process.memory.external",
      value: memory.external,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    PerformanceMetrics.record({
      name: "process.memory.array_buffers",
      value: memory.arrayBuffers,
      unit: "bytes",
      module: "process",
      source: "process",
    })
    if (memory.rss >= (config.thresholds.highRssBytes ?? PerformanceConfig.defaults.thresholds.highRssBytes)) {
      PerformanceIssues.raise({
        code: "PERF_MEMORY_HIGH_RSS",
        severity: "warning",
        module: "process",
        title: "High RSS memory usage",
        message: `Process RSS is ${memory.rss} bytes`,
        evidence: { observedValue: memory.rss, thresholdValue: config.thresholds.highRssBytes ?? null, unit: "bytes" },
      })
    }
    if (lagMs >= (config.thresholds.eventLoopLagMs ?? PerformanceConfig.defaults.thresholds.eventLoopLagMs)) {
      PerformanceIssues.raise({
        code: "PERF_EVENT_LOOP_LAG",
        severity: "warning",
        module: "process",
        title: "Event loop lag detected",
        message: `Event loop lag is ${Math.round(lagMs)}ms`,
        evidence: { observedValue: lagMs, thresholdValue: config.thresholds.eventLoopLagMs ?? null, unit: "ms" },
      })
    }
    const highExternalThreshold =
      config.thresholds.highExternalBytes ?? PerformanceConfig.defaults.thresholds.highExternalBytes
    if (memory.external >= highExternalThreshold) {
      PerformanceIssues.raise({
        code: "PERF_MEMORY_HIGH_EXTERNAL",
        severity: "warning",
        module: "process",
        title: "High external memory usage",
        message: `Process external memory is ${memory.external} bytes`,
        evidence: { observedValue: memory.external, thresholdValue: highExternalThreshold, unit: "bytes" },
      })
    }
    const highArrayBuffersThreshold =
      config.thresholds.highArrayBuffersBytes ?? PerformanceConfig.defaults.thresholds.highArrayBuffersBytes
    if (memory.arrayBuffers >= highArrayBuffersThreshold) {
      PerformanceIssues.raise({
        code: "PERF_MEMORY_HIGH_ARRAY_BUFFERS",
        severity: "warning",
        module: "process",
        title: "High ArrayBuffers memory usage",
        message: `Process ArrayBuffers memory is ${memory.arrayBuffers} bytes`,
        evidence: { observedValue: memory.arrayBuffers, thresholdValue: highArrayBuffersThreshold, unit: "bytes" },
      })
    }
  }

  export function start() {
    if (timer) return
    const config = PerformanceConfig.current()
    if (!config.enabled) return
    eventLoopExpected = Date.now() + config.resourceSampleIntervalMs
    timer = setInterval(snapshot, config.resourceSampleIntervalMs)
    timer.unref()
  }

  export function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function truncateLabel(value: string) {
    return value.length > 512 ? value.slice(0, 509) + "..." : value
  }
}
