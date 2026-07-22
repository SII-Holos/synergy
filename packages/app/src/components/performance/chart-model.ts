import type { MessageDescriptor } from "@lingui/core"
import type { ChartData, ChartOptions, TooltipItem } from "chart.js"
import { withAlpha, type HexColor } from "@ericsanchezok/synergy-ui/theme"
import type { BrowserMetricSample, PerformanceMetricPoint, PerformanceSummary, PerformanceTimeline } from "./types"
import { P } from "./performance-i18n"
import type { ChartTheme } from "../visualization/use-chart-theme"

export const CHART_METRICS = [
  "process.cpu.utilization",
  "process.event_loop.lag",
  "service.memory.current",
  "process.memory.rss",
  "process.memory.heap_used",
  "process.memory.heap_total",
  "process.memory.external",
  "process.memory.array_buffers",
  "http.request.duration",
  "session.turn.duration",
  "session.turn.active",
  "storage.operation.count",
  "storage.operation.duration",
  "storage.read.bytes",
  "storage.write.bytes",
]

export type ChartUnit = "ms" | "bytes" | "count" | "ratio" | "percent" | "megabytes" | "tokens" | "microseconds"

export type ChartDatasetSpec = {
  label: string
  field: keyof PerformanceMetricPoint
  unit: ChartUnit
  stat?: string
  axisId: string
  axisTitle: string
  color: HexColor
  formatter?: (value: number) => string
  source?: string
}

export type PerformanceLineChartModel = {
  data: ChartData<"line", Array<{ x: number; y: number | null }>>
  options: ChartOptions<"line">
}

export function buildLineChartModel(input: {
  points: PerformanceMetricPoint[]
  datasets: ChartDatasetSpec[]
  theme: ChartTheme
  formatTime: (value: number) => string
}): PerformanceLineChartModel {
  const axisSpecs = uniqueAxes(input.datasets)
  const timestamps = input.points.map((point) => pointTimestamp(point))
  return {
    data: {
      datasets: input.datasets.map((dataset) => ({
        label: dataset.stat ? `${dataset.label} (${dataset.stat})` : dataset.label,
        data: input.points.map((point, index) => ({
          x: timestamps[index],
          y: numberValue(point[dataset.field]),
        })),
        borderColor: dataset.color,
        backgroundColor: withAlpha(dataset.color, 0.12),
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 0,
        spanGaps: true,
        pointHoverRadius: 4,
        pointBackgroundColor: dataset.color,
        pointBorderColor: input.theme.background,
        pointHoverBackgroundColor: input.theme.background,
        pointHoverBorderColor: dataset.color,
        yAxisID: dataset.axisId,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { ...input.theme.legend.labels, boxWidth: 8, boxHeight: 8 } },
        tooltip: {
          ...input.theme.tooltip,
          mode: "index",
          intersect: false,
          callbacks: {
            label: (context) => tooltipLabel(context, input.datasets),
            title: (context) => {
              const x = context[0]?.parsed?.x
              return x != null ? input.formatTime(x) : ""
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          border: { display: false },
          grid: { display: false },
          ticks: {
            color: input.theme.axis,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            callback: (value: string | number) => input.formatTime(Number(value)),
          },
        },
        ...Object.fromEntries(axisSpecs.map((axis, index) => [axis.axisId, axisOptions(axis, index, input.theme)])),
      },
      animation: { duration: 500, easing: "easeOutQuart" },
    },
  }
}

function pointTimestamp(point: PerformanceMetricPoint): number {
  if (typeof point.timestamp === "number") return point.timestamp
  if (typeof point.timestamp === "string") {
    const parsed = Date.parse(point.timestamp)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

export function resourcePressurePoints(timeline: PerformanceTimeline | null | undefined): PerformanceMetricPoint[] {
  return pointsFromTimeline(timeline, {
    "process.cpu.utilization": (value, point) => ({ ...point, cpu: ratioToPercent(value) }),
    "process.event_loop.lag": (value, point) => ({ ...point, eventLoopLag: value }),
  })
}

export function memoryPoints(
  timeline: PerformanceTimeline | null | undefined,
  summary?: PerformanceSummary | null,
): PerformanceMetricPoint[] {
  const points = pointsFromTimeline(timeline, {
    "service.memory.current": (value, point) => ({ ...point, serviceMemory: value / 1024 / 1024 }),
    "process.memory.rss": (value, point) => ({ ...point, memory: value / 1024 / 1024 }),
    "process.memory.heap_used": (value, point) => ({ ...point, heapUsed: value / 1024 / 1024 }),
    "process.memory.heap_total": (value, point) => ({ ...point, heapTotal: value / 1024 / 1024 }),
    "process.memory.external": (value, point) => ({ ...point, external: value / 1024 / 1024 }),
    "process.memory.array_buffers": (value, point) => ({ ...point, arrayBuffers: value / 1024 / 1024 }),
  })
  if (points.length > 0) return points
  if (!summary?.resources) return []
  return [
    {
      timestamp: summary.generatedAt,
      serviceMemory: bytesToMegabytes(summary.serviceMemory?.currentBytes),
      memory: bytesToMegabytes(summary.resources.rssBytes),
      heapUsed: bytesToMegabytes(summary.resources.heapUsedBytes),
      heapTotal: bytesToMegabytes(summary.resources.heapTotalBytes),
      external: bytesToMegabytes(summary.resources.externalBytes),
      arrayBuffers: bytesToMegabytes(summary.resources.arrayBuffersBytes),
    },
  ]
}

export function requestPoints(timeline: PerformanceTimeline | null | undefined): PerformanceMetricPoint[] {
  return pointsFromTimeline(timeline, {
    "http.request.duration": (value, point, seriesPoint) => ({
      ...point,
      latency: value,
      requests: seriesPoint.sampleCount,
    }),
  })
}

export function sessionPoints(timeline: PerformanceTimeline | null | undefined): PerformanceMetricPoint[] {
  return pointsFromTimeline(timeline, {
    "session.turn.active": (value, point) => ({ ...point, activeSessions: value }),
    "session.turn.duration": (value, point) => ({ ...point, latency: value }),
  })
}

export function storagePoints(timeline: PerformanceTimeline | null | undefined): PerformanceMetricPoint[] {
  return pointsFromTimeline(timeline, {
    "storage.operation.count": (value, point) => ({ ...point, diskOps: value }),
    "storage.operation.duration": (value, point) => ({ ...point, latency: value }),
    "storage.read.bytes": (value, point) => ({ ...point, readBytes: value }),
    "storage.write.bytes": (value, point) => ({ ...point, writeBytes: value }),
  })
}

export function browserMetricPoints(samples: BrowserMetricSample[]): PerformanceMetricPoint[] {
  return samples.map((sample) => ({
    timestamp: sample.timestamp,
    memory: bytesToMegabytes(sample.memory),
    domNodes: sample.domNodes,
    latency: sample.navigationMs,
  }))
}

export function pointsFromTimeline(
  timeline: PerformanceTimeline | null | undefined,
  mappers: Record<
    string,
    (
      value: number,
      point: PerformanceMetricPoint,
      seriesPoint: { time: number; value: number | null; sampleCount?: number },
    ) => PerformanceMetricPoint
  >,
): PerformanceMetricPoint[] {
  if (!timeline?.series.length) return []
  const byTime = new Map<number, PerformanceMetricPoint>()
  const timestamps = new Set<number>()
  for (const series of timeline.series) {
    if (!mappers[series.name]) continue
    for (const item of series.points) timestamps.add(item.time)
  }
  for (const time of timestamps) byTime.set(time, { timestamp: time })
  for (const series of timeline.series) {
    const mapValue = mappers[series.name]
    if (!mapValue) continue
    for (const item of series.points) {
      const current = byTime.get(item.time) ?? { timestamp: item.time }
      byTime.set(item.time, item.value === null ? current : mapValue(item.value, current, item))
    }
  }
  return [...byTime.values()].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
}

export function summaryQualityMessage(summary: PerformanceSummary | null | undefined): MessageDescriptor | undefined {
  if (summary?.quality?.truncated || summary?.quality?.partial) return P.qualitySummaryPartial
  return undefined
}

export function formatMetricValue(value: number | undefined, unit: string): string {
  if (value === undefined) return "—"
  if (unit === "ms") return formatDuration(value)
  if (unit === "bytes") return formatBytes(value)
  if (unit === "ratio") return formatPercent(ratioToPercent(value))
  if (unit === "percent") return formatPercent(value)
  if (unit === "megabytes") return `${value.toFixed(value >= 10 ? 0 : 1)} MB`
  return value.toFixed(value >= 10 ? 0 : 1)
}

export function formatPercent(value?: number): string {
  if (value === undefined) return "—"
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

export function formatBytes(value?: number): string {
  if (value === undefined) return "—"
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`
  return `${value.toFixed(0)} B`
}

export function formatDuration(value?: number): string {
  if (value === undefined) return "—"
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
  return `${value.toFixed(0)}ms`
}

export function ratioToPercent(value?: number): number | undefined {
  if (value === undefined) return undefined
  return value <= 1 ? value * 100 : value
}

function tooltipLabel(context: TooltipItem<"line">, datasets: ChartDatasetSpec[]) {
  const spec = datasets[context.datasetIndex]
  const value = typeof context.parsed.y === "number" ? context.parsed.y : undefined
  const formatter = spec?.formatter ?? ((item: number) => formatMetricValue(item, spec?.unit ?? "count"))
  const stat = spec?.stat ? ` ${spec.stat}` : ""
  return `${spec?.label ?? context.dataset.label}${stat}: ${value === undefined ? "—" : formatter(value)}`
}

function axisOptions(
  axis: Pick<ChartDatasetSpec, "axisId" | "axisTitle" | "formatter">,
  index: number,
  theme: ChartTheme,
) {
  return {
    type: "linear",
    position: index === 0 ? "left" : "right",
    border: { display: false },
    grid: { color: theme.grid, drawOnChartArea: index === 0 },
    ticks: {
      color: theme.axis,
      callback: (value: string | number) => axis.formatter?.(Number(value)) ?? String(value),
    },
    title: { display: true, color: theme.axis, text: axis.axisTitle },
  }
}

function uniqueAxes(datasets: ChartDatasetSpec[]) {
  const axes = new Map<string, ChartDatasetSpec>()
  for (const dataset of datasets) {
    if (!axes.has(dataset.axisId)) axes.set(dataset.axisId, dataset)
  }
  return [...axes.values()]
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value
}

function bytesToMegabytes(value?: number) {
  if (value === undefined) return undefined
  return value / 1024 / 1024
}
