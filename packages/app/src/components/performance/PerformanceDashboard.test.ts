import { describe, expect, test } from "bun:test"
import {
  browserMetricPoints,
  buildLineChartModel,
  memoryPoints,
  requestPoints,
  resourcePressurePoints,
  summaryQualityMessage,
  type ChartDatasetSpec,
} from "./chart-model"
import { runtimeSupportItems } from "./runtime-support"
import { toolFailureCategories } from "./tool-failure-model"
import type { PerformanceSummary, PerformanceTimeline } from "./types"

function summary(runtime: Partial<PerformanceSummary["runtime"]>): PerformanceSummary {
  return {
    generatedAt: new Date(0).toISOString(),
    windowMs: 900_000,
    health: { status: "healthy", score: 100, openIssueCount: 0, criticalIssueCount: 0 },
    backend: { requestCount: 0, errorRate: 0, activeSessions: 0, pendingSessions: 0 },
    resources: {},
    sessions: { turnCount: 0, llmCallCount: 0, toolCallCount: 0 },
    frontend: { longTaskCount: 0 },
    runtime: {
      mirrorFiles: 0,
      traceFiles: 0,
      recentErrors: 0,
      pendingSessions: 0,
      sessionRuntimes: {
        totalCount: 0,
        runningCount: 0,
        idleCount: 0,
        childCount: 0,
        userCount: 0,
        waiterCount: 0,
      },
      cortexTasks: {
        totalCount: 0,
        queuedCount: 0,
        runningCount: 0,
        completedCount: 0,
        errorCount: 0,
        cancelledCount: 0,
        interruptedCount: 0,
        retainedPromptChars: 0,
        retainedOutputChars: 0,
        retainedErrorChars: 0,
        retainedProgressToolCount: 0,
      },
      ...runtime,
    },
    top: {
      slowRoutes: [],
      slowSessions: [],
      slowTools: [],
      toolFailures: [],
      slowProviders: [],
      slowStorage: [],
      slowLibrary: [],
      childProcesses: [],
      slowFrontend: [],
    },
    issues: [],
  }
}

const datasetSpecs: ChartDatasetSpec[] = [
  { label: "CPU avg", field: "cpu", unit: "percent", axisId: "percent", axisTitle: "Percent", color: "#2563eb" },
  { label: "Memory", field: "memory", unit: "megabytes", axisId: "memory", axisTitle: "Memory (MB)", color: "#16805d" },
  {
    label: "Event loop p95",
    field: "eventLoopLag",
    unit: "ms",
    axisId: "duration",
    axisTitle: "Milliseconds",
    color: "#b7791f",
  },
]
const chartTheme = { axisText: "#6b7280", gridColor: "#d1d5db" }

function timeline(series: PerformanceTimeline["series"]): PerformanceTimeline {
  return { generatedAt: new Date(0).toISOString(), from: 1000, to: 3000, bucketMs: 1000, series }
}

describe("performance chart model", () => {
  test("resource chart assigns each dataset to a unit axis", () => {
    const model = buildLineChartModel({
      points: [{ timestamp: 1000, cpu: 25, memory: 512, eventLoopLag: 12 }],
      datasets: datasetSpecs,
      theme: chartTheme,
    })
    expect(model.data.datasets.every((dataset) => dataset.yAxisID)).toBe(true)
    const scales = model.options.scales ?? {}
    expect(scales.percent).toBeDefined()
    expect(scales.memory).toBeDefined()
    expect(scales.duration).toBeDefined()
    expect(new Set(model.data.datasets.map((dataset) => dataset.yAxisID)).size).toBeGreaterThan(1)
  })

  test("request chart does not invent session or disk time series from static summary", () => {
    const points = requestPoints(
      timeline([
        {
          name: "http.request.duration",
          unit: "ms",
          stat: "p95",
          kind: "duration",
          sampleCount: 1,
          points: [{ time: 1000, value: 50, sampleCount: 1 }],
        },
      ]),
    )
    expect(points).toEqual([{ timestamp: 1000, latency: 50, requests: 1 }])
  })

  test("points from timeline align sparse metrics by timestamp", () => {
    const points = resourcePressurePoints(
      timeline([
        {
          name: "process.cpu.utilization",
          unit: "ratio",
          stat: "avg",
          kind: "ratio",
          points: [
            { time: 1000, value: null, sampleCount: 0 },
            { time: 2000, value: 0.42, sampleCount: 1 },
          ],
        },
        {
          name: "process.event_loop.lag",
          unit: "ms",
          stat: "p95",
          kind: "duration",
          points: [
            { time: 1000, value: 8, sampleCount: 1 },
            { time: 2000, value: 11, sampleCount: 1 },
          ],
        },
      ]),
    )
    expect(points.map((point) => point.timestamp)).toEqual([1000, 2000])
    expect(points[0].cpu).toBeUndefined()
    expect(points[0].eventLoopLag).toBe(8)
    expect(points[1].cpu).toBe(42)
  })

  test("timeline memory bytes convert to MB without losing sparse gaps", () => {
    const points = memoryPoints(
      timeline([
        {
          name: "process.memory.rss",
          unit: "bytes",
          stat: "latest",
          kind: "gauge",
          points: [
            { time: 1000, value: 1048576, sampleCount: 1 },
            { time: 2000, value: null, sampleCount: 0 },
          ],
        },
      ]),
    )
    expect(points).toEqual([{ timestamp: 1000, memory: 1 }, { timestamp: 2000 }])
  })

  test("browser metric chart uses separate axes for heap DOM nodes and navigation latency", () => {
    const points = browserMetricPoints([{ timestamp: 1000, memory: 1048576, domNodes: 42, navigationMs: 120 }])
    const model = buildLineChartModel({
      points,
      datasets: [
        {
          label: "Heap",
          field: "memory",
          unit: "megabytes",
          axisId: "memory",
          axisTitle: "Memory (MB)",
          color: "#7c3aed",
        },
        { label: "DOM", field: "domNodes", unit: "count", axisId: "count", axisTitle: "Count", color: "#16805d" },
        {
          label: "Navigation",
          field: "latency",
          unit: "ms",
          axisId: "duration",
          axisTitle: "Milliseconds",
          color: "#b7791f",
        },
      ],
      theme: chartTheme,
    })
    expect(points[0]).toMatchObject({ memory: 1, domNodes: 42, latency: 120 })
    expect(new Set(model.data.datasets.map((dataset) => dataset.yAxisID))).toEqual(
      new Set(["memory", "count", "duration"]),
    )
  })

  test("line chart model keeps missing values as gaps", () => {
    const model = buildLineChartModel({
      points: [
        { timestamp: 1000, cpu: undefined },
        { timestamp: 2000, cpu: Number.NaN },
        { timestamp: 3000, cpu: Number.POSITIVE_INFINITY },
      ],
      datasets: [datasetSpecs[0]],
      theme: chartTheme,
    })
    expect(model.data.datasets[0].data).toEqual([
      { x: 1000, y: null },
      { x: 2000, y: null },
      { x: 3000, y: null },
    ])
  })

  test("summary quality warning uses quiet partial copy", () => {
    const baseSummary = summary({ mirrorFiles: 0, recentErrors: 0, pendingSessions: 0 })
    expect(summaryQualityMessage({ ...baseSummary, quality: { partial: true, truncated: true } })).toBe(
      "Summary is partial because the metric volume exceeded the dashboard cap.",
    )
    expect(summaryQualityMessage(baseSummary)).toBeUndefined()
  })
})

describe("performance dashboard tool failures", () => {
  test("formats ranked error categories without exposing error messages", () => {
    expect(
      toolFailureCategories({
        tool: "websearch",
        callCount: 4,
        errorCount: 2,
        errorRate: 0.5,
        categories: [
          { errorClass: "TimeoutError", count: 2 },
          { errorClass: "PolicyDenied", count: 1 },
        ],
      }),
    ).toBe("TimeoutError ×2 · PolicyDenied ×1")
  })

  test("reports a quiet fallback when no error category was captured", () => {
    expect(toolFailureCategories({ tool: "bash", callCount: 0, errorCount: 1, errorRate: 1, categories: [] })).toBe(
      "No error category reported",
    )
  })
})

describe("performance dashboard runtime support", () => {
  test("surfaces diagnostics-derived runtime health fields", () => {
    const items = runtimeSupportItems(
      summary({
        alive: true,
        healthy: true,
        pid: 42,
        mode: "server",
        mirrorFiles: 3,
        recentErrors: 0,
        pendingSessions: 2,
      }),
    )
    expect(items).toContainEqual({ label: "Mirror files", value: "3 files", tone: "default" })
    expect(items).toContainEqual({ label: "Recent errors", value: "0", tone: "default" })
    expect(items).toContainEqual({ label: "Pending sessions", value: "2", tone: "warning" })
    expect(items).toContainEqual({ label: "Session runtimes", value: "0 total · 0 running", tone: "default" })
    expect(items).toContainEqual({ label: "Cortex tasks", value: "0 retained · 0 running", tone: "default" })
    expect(items[0].value).toContain("Alive")
    expect(items[0].value).toContain("pid 42")
    expect(items[0].tone).toBe("success")
  })

  test("marks unhealthy runtime support state as warning", () => {
    const items = runtimeSupportItems(
      summary({ alive: false, healthy: false, mirrorFiles: 0, recentErrors: 5, pendingSessions: 0 }),
    )
    expect(items[0].tone).toBe("warning")
    expect(items[0].value).toContain("Not running")
    expect(items[2]).toEqual({ label: "Recent errors", value: "5", tone: "warning" })
  })
})
