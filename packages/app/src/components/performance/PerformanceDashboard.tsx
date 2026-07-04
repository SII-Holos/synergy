import { createMemo, createSignal, For, Show } from "solid-js"
import { Line } from "solid-chartjs"
import {
  Chart as ChartJS,
  CategoryScale,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
} from "chart.js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { usePerformance } from "./use-performance"
import type {
  BrowserMetricSample,
  PerformanceIssue,
  PerformanceMetricPoint,
  PerformanceSummary,
  PerformanceTraceSpan,
} from "./types"

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const AXIS_TEXT = "rgba(125,122,118,.84)"
const GRID_COLOR = "rgba(124,118,110,.14)"
const CPU_COLOR = "rgba(56, 88, 182, 0.92)"
const MEMORY_COLOR = "rgba(39, 143, 116, 0.92)"
const REQUEST_COLOR = "rgba(196, 132, 36, 0.88)"
const BROWSER_COLOR = "rgba(112, 92, 196, 0.86)"

export function PerformanceDashboard() {
  const perf = usePerformance()
  const [selectedTrace, setSelectedTrace] = createSignal<PerformanceTraceSpan | null>(null)
  const summary = () => perf.summary()
  const issues = createMemo(() => [...perf.eventIssues(), ...(summary()?.issues ?? [])].slice(0, 12))
  const traces = createMemo(() => perf.eventTraces().slice(0, 24))

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3 rounded-xl border border-border-weaker-base bg-surface-base px-4 py-3">
        <div class="flex items-center gap-2 text-12-medium text-text-weak">
          <span
            classList={{
              "h-2 w-2 rounded-full": true,
              "bg-icon-success-base": perf.connected(),
              "bg-icon-warning-base": !perf.connected(),
            }}
          />
          {perf.connected() ? "Live performance stream connected" : "Waiting for performance stream"}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="small"
          icon={getSemanticIcon("action.refresh")}
          disabled={perf.loading}
          onClick={() => void perf.refresh()}
        >
          Refresh
        </Button>
      </div>

      <Show when={perf.error() || perf.streamError()}>
        <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base px-4 py-3 text-12-regular text-icon-warning-base">
          {perf.error() ?? perf.streamError()}
        </div>
      </Show>

      <SummaryCards summary={summary()} issues={issues()} />

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ResourceChart
          title="CPU and memory"
          description="Runtime resource pressure over recent samples"
          points={mergeResourceSeries(summary())}
          datasets={[
            { label: "CPU %", field: "cpu", color: CPU_COLOR },
            { label: "Memory MB", field: "memory", color: MEMORY_COLOR },
          ]}
        />
        <ResourceChart
          title="Requests and sessions"
          description="Throughput, latency, and active session movement"
          points={requestPoints(summary())}
          datasets={[
            { label: "Requests", field: "requests", color: REQUEST_COLOR },
            { label: "Latency ms", field: "latency", color: CPU_COLOR },
            { label: "Sessions", field: "activeSessions", color: MEMORY_COLOR },
          ]}
        />
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Timeline traces={traces()} onSelect={setSelectedTrace} />
        <IssueList issues={issues()} />
      </div>

      <BrowserMetrics samples={perf.browserSamples()} />
      <TraceDrawer trace={selectedTrace()} onClose={() => setSelectedTrace(null)} />
    </div>
  )
}

function SummaryCards(props: { summary: PerformanceSummary | null | undefined; issues: PerformanceIssue[] }) {
  const summary = () => props.summary
  const health = () => summary()?.health.status
  return (
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Health" value={health() ?? "Unknown"} icon="perf.health" />
      <MetricCard label="HTTP p95" value={formatDuration(summary()?.backend.p95RequestMs)} icon="perf.latency" />
      <MetricCard
        label="CPU"
        value={formatPercent(ratioToPercent(summary()?.resources.cpuUtilizationRatio))}
        icon="perf.cpu"
      />
      <MetricCard label="Memory" value={formatBytes(summary()?.resources.rssBytes)} icon="perf.memory" />
      <MetricCard
        label="Issues"
        value={String(props.issues.length)}
        icon="perf.issue"
        tone={props.issues.length > 0 ? "warning" : "default"}
      />
      <MetricCard label="Sessions" value={String(summary()?.backend.activeSessions ?? 0)} icon="perf.trace" />
      <MetricCard label="LLM calls" value={String(summary()?.sessions?.llmCallCount ?? 0)} icon="perf.network" />
      <MetricCard label="Tool calls" value={String(summary()?.sessions?.toolCallCount ?? 0)} icon="perf.disk" />
    </div>
  )
}

function MetricCard(props: {
  label: string
  value: string
  icon: Parameters<typeof getSemanticIcon>[0]
  tone?: "default" | "warning"
}) {
  return (
    <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
      <div class="flex items-center justify-between gap-3">
        <div class="text-11-medium uppercase tracking-[0.12em] text-text-weaker">{props.label}</div>
        <Icon
          name={getSemanticIcon(props.icon)}
          size="small"
          classList={{ "text-icon-weak": props.tone !== "warning", "text-icon-warning-base": props.tone === "warning" }}
        />
      </div>
      <div class="mt-2 truncate text-20-semibold text-text-strong tabular-nums">{props.value}</div>
    </div>
  )
}

function ResourceChart(props: {
  title: string
  description: string
  points: PerformanceMetricPoint[]
  datasets: Array<{ label: string; field: keyof PerformanceMetricPoint; color: string }>
}) {
  const chartData = createMemo<ChartData<"line">>(() => ({
    labels: props.points.map((point, index) => formatPointLabel(point, index)),
    datasets: props.datasets.map((dataset) => ({
      label: dataset.label,
      data: props.points.map((point) => numberValue(point[dataset.field])),
      borderColor: dataset.color,
      backgroundColor: dataset.color.replace("0.9", "0.12").replace("0.88", "0.12").replace("0.92", "0.12"),
      fill: true,
      tension: 0.35,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
    })),
  }))

  const chartOptions = createMemo<ChartOptions<"line">>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: AXIS_TEXT, boxWidth: 8, boxHeight: 8 } },
      tooltip: { mode: "index", intersect: false },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: AXIS_TEXT, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
      y: { border: { display: false }, grid: { color: GRID_COLOR }, ticks: { color: AXIS_TEXT } },
    },
    animation: { duration: 500, easing: "easeOutQuart" },
  }))

  return (
    <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
      <div class="mb-3">
        <h3 class="text-14-semibold text-text-strong">{props.title}</h3>
        <p class="mt-1 text-11-regular text-text-weak">{props.description}</p>
      </div>
      <Show when={props.points.length > 0} fallback={<EmptyState label="No resource samples yet" />}>
        <div class="h-56">
          <Line data={chartData()} options={chartOptions()} />
        </div>
      </Show>
    </div>
  )
}

function Timeline(props: { traces: PerformanceTraceSpan[]; onSelect: (trace: PerformanceTraceSpan) => void }) {
  return (
    <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("perf.timeline")} size="small" class="text-icon-weak" />
        <h3 class="text-14-semibold text-text-strong">Trace timeline</h3>
      </div>
      <Show when={props.traces.length > 0} fallback={<EmptyState label="No trace spans reported" />}>
        <div class="flex flex-col gap-2">
          <For each={props.traces}>
            {(trace) => (
              <button
                type="button"
                class="flex items-center gap-3 rounded-lg bg-surface-inset-base/70 px-3 py-2 text-left transition-colors hover:bg-surface-hover-base"
                onClick={() => props.onSelect(trace)}
              >
                <div class="h-2 w-2 shrink-0 rounded-full bg-icon-accent-base" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-12-medium text-text-strong">{trace.name}</div>
                  <div class="truncate text-11-regular text-text-weaker">{trace.traceId}</div>
                </div>
                <div class="text-11-medium text-text-weak tabular-nums">{formatDuration(trace.durationMs)}</div>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function IssueList(props: { issues: PerformanceIssue[] }) {
  return (
    <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("perf.issue")} size="small" class="text-icon-weak" />
        <h3 class="text-14-semibold text-text-strong">Performance issues</h3>
      </div>
      <Show when={props.issues.length > 0} fallback={<EmptyState label="No active performance issues" />}>
        <div class="flex flex-col gap-2">
          <For each={props.issues}>
            {(issue) => (
              <div class="rounded-lg bg-surface-inset-base/70 p-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="truncate text-12-medium text-text-strong">
                    {issue.title ?? issue.message ?? "Performance issue"}
                  </div>
                  <span class={severityClass(issue.severity)}>{issue.severity ?? "info"}</span>
                </div>
                <div class="mt-1 line-clamp-2 text-11-regular text-text-weak">{issue.message}</div>
                <div class="mt-1 text-11-regular text-text-weaker">
                  {[issue.module, formatTime(issue.iso)].filter(Boolean).join(" · ")}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function BrowserMetrics(props: { samples: BrowserMetricSample[] }) {
  return (
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_0.85fr]">
      <ResourceChart
        title="Browser metrics"
        description="Client-side DOM, navigation, and heap samples collected by this settings view"
        points={props.samples.map((sample) => ({
          timestamp: sample.timestamp,
          memory: sample.memory ? sample.memory / 1024 / 1024 : undefined,
          requests: sample.domNodes,
          latency: sample.navigationMs,
        }))}
        datasets={[
          { label: "Heap MB", field: "memory", color: BROWSER_COLOR },
          { label: "DOM nodes", field: "requests", color: MEMORY_COLOR },
          { label: "Navigation ms", field: "latency", color: REQUEST_COLOR },
        ]}
      />
      <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
        <div class="mb-3 flex items-center gap-2">
          <Icon name={getSemanticIcon("perf.frontend")} size="small" class="text-icon-weak" />
          <h3 class="text-14-semibold text-text-strong">Frontend vitals</h3>
        </div>
        <div class="grid grid-cols-2 gap-2 text-12-regular">
          <EmptyState label="Vitals are ingested in the background and appear once the browser reports them." />
        </div>
      </div>
    </div>
  )
}

function TraceDrawer(props: { trace: PerformanceTraceSpan | null; onClose: () => void }) {
  return (
    <Show when={props.trace}>
      {(trace) => (
        <div class="fixed inset-y-0 right-0 z-[80] w-[min(420px,100vw)] border-l border-border-weaker-base bg-surface-raised-stronger-non-alpha p-5 shadow-2xl">
          <div class="mb-4 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="truncate text-16-semibold text-text-strong">{trace().name}</h3>
              <p class="mt-1 truncate text-11-regular text-text-weaker">{trace().traceId}</p>
            </div>
            <button
              type="button"
              class="rounded-lg p-1.5 text-icon-weak hover:bg-surface-hover-base"
              onClick={props.onClose}
            >
              <Icon name={getSemanticIcon("action.close")} size="small" />
            </button>
          </div>
          <div class="flex flex-col gap-3 text-12-regular">
            <DetailRow label="Status" value={trace().status ?? "unknown"} />
            <DetailRow label="Duration" value={formatDuration(trace().durationMs)} />
            <DetailRow label="Start" value={formatTime(trace().startedAt)} />
            <DetailRow label="End" value={formatTime(trace().endedAt)} />
            <Show when={trace().errorCode}>
              <div class="rounded-lg bg-surface-inset-base/70 p-3 text-icon-warning-base">{trace().errorCode}</div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between gap-3 border-b border-border-weaker-base pb-2">
      <span class="text-text-weaker">{props.label}</span>
      <span class="truncate text-text-base">{props.value}</span>
    </div>
  )
}

function EmptyState(props: { label: string }) {
  return (
    <div class="rounded-lg bg-surface-inset-base/70 px-3 py-8 text-center text-12-regular text-text-weaker">
      {props.label}
    </div>
  )
}

function mergeResourceSeries(summary?: PerformanceSummary | null): PerformanceMetricPoint[] {
  if (!summary?.resources) return []
  return [
    {
      timestamp: summary.generatedAt,
      cpu: ratioToPercent(summary.resources.cpuUtilizationRatio),
      memory: summary.resources.rssBytes ? summary.resources.rssBytes / 1024 / 1024 : undefined,
    },
  ]
}

function requestPoints(summary?: PerformanceSummary | null): PerformanceMetricPoint[] {
  if (!summary?.backend) return []
  return [
    {
      timestamp: summary.generatedAt,
      requests: summary.backend.requestCount,
      latency: summary.backend.p95RequestMs,
      activeSessions: summary.backend.activeSessions,
    },
  ]
}

function formatPointLabel(point: PerformanceMetricPoint, index: number): string {
  const value = point.label ?? point.timestamp
  if (value === undefined) return String(index + 1)
  if (typeof value === "number") return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return value
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value
}

function ratioToPercent(value?: number): number | undefined {
  if (value === undefined) return undefined
  return value <= 1 ? value * 100 : value
}

function formatPercent(value?: number): string {
  if (value === undefined) return "—"
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function formatBytes(value?: number): string {
  if (value === undefined) return "—"
  const bytes = value > 10_000_000 ? value : value * 1024 * 1024
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

function formatDuration(value?: number): string {
  if (value === undefined) return "—"
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
  return `${value.toFixed(0)}ms`
}

function formatTime(value?: number | string): string {
  if (value === undefined) return ""
  const time = typeof value === "number" ? value : Date.parse(value)
  if (Number.isNaN(time)) return String(value)
  return new Date(time).toLocaleString()
}

function severityClass(severity?: string): string {
  const base = "shrink-0 rounded-full px-2 py-0.5 text-10-medium uppercase tracking-[0.1em]"
  if (severity === "critical" || severity === "error") return `${base} bg-icon-critical-base/15 text-icon-critical-base`
  if (severity === "warning") return `${base} bg-icon-warning-base/15 text-icon-warning-base`
  return `${base} bg-surface-base text-text-weaker`
}
