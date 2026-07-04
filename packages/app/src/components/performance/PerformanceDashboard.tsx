import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
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
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { usePerformance } from "./use-performance"
import { runtimeSupportItems } from "./runtime-support"
import type {
  BrowserMetricSample,
  PerformanceIssue,
  PerformanceMetricPoint,
  PerformanceSummary,
  PerformanceTimeline,
  PerformanceTraceDetail,
  PerformanceTraceSpan,
} from "./types"

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const AXIS_TEXT = "rgba(125,122,118,.84)"
const GRID_COLOR = "rgba(124,118,110,.14)"
const CPU_COLOR = "rgba(56, 88, 182, 0.92)"
const MEMORY_COLOR = "rgba(39, 143, 116, 0.92)"
const REQUEST_COLOR = "rgba(196, 132, 36, 0.88)"
const BROWSER_COLOR = "rgba(112, 92, 196, 0.86)"
const DISK_COLOR = "rgba(172, 92, 48, 0.88)"

const TIME_RANGES = [
  { label: "15m", value: 15 * 60_000 },
  { label: "1h", value: 60 * 60_000 },
  { label: "6h", value: 6 * 60 * 60_000 },
  { label: "24h", value: 24 * 60 * 60_000 },
]

type RankedItem = PerformanceSummary["top"]["slowRoutes"][number]

export function PerformanceDashboard() {
  const perf = usePerformance()
  const [selectedTrace, setSelectedTrace] = createSignal<PerformanceTraceSpan | null>(null)
  const [selectedTraceDetail, setSelectedTraceDetail] = createSignal<PerformanceTraceDetail | null>(null)
  const summary = () => perf.summary()
  const issues = createMemo(() => [...perf.eventIssues(), ...(summary()?.issues ?? [])].slice(0, 12))
  const traces = createMemo(() => perf.eventTraces().slice(0, 24))

  const selectTrace = async (traceId: string, fallback?: Partial<PerformanceTraceSpan>) => {
    const detail = await perf.loadTrace(traceId).catch(() => null)
    setSelectedTraceDetail(detail ?? null)
    const root = detail?.root
    setSelectedTrace(
      root
        ? ({
            traceId,
            kind: "runtime",
            name: root.name,
            status: root.status,
            startedAt: root.startTime
              ? new Date(root.startTime).toISOString()
              : (fallback?.startedAt ?? new Date().toISOString()),
            endedAt: root.endTime ? new Date(root.endTime).toISOString() : fallback?.endedAt,
            durationMs: root.durationMs,
            module: root.module,
            sessionID: root.sessionID,
            redactionApplied: true,
          } as PerformanceTraceSpan)
        : ({
            traceId,
            kind: "runtime",
            name: fallback?.name ?? traceId,
            status: fallback?.status ?? "ok",
            startedAt: fallback?.startedAt ?? new Date().toISOString(),
            durationMs: fallback?.durationMs,
            module: fallback?.module,
            sessionID: fallback?.sessionID,
            redactionApplied: fallback?.redactionApplied ?? true,
          } as PerformanceTraceSpan),
    )
  }

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-weaker-base bg-surface-base px-4 py-3">
        <div class="flex items-center gap-2 text-12-medium text-text-weak">
          <span
            classList={{
              "h-2 w-2 rounded-full": true,
              "bg-icon-success-base": perf.connected(),
              "bg-icon-warning-base": !perf.connected(),
            }}
          />
          {perf.connected() ? "Live performance stream connected" : "Polling performance data while stream reconnects"}
        </div>
        <div class="flex items-center gap-2">
          <TimeRangeControl value={perf.windowMs()} onChange={(value) => perf.setWindowMs(value)} />
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("action.refresh")}
            disabled={perf.loading}
            onClick={() => {
              void perf.refresh()
              void perf.loadTimeline(perf.windowMs())
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      <Show when={perf.error() || perf.streamError()}>
        <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base px-4 py-3 text-12-regular text-icon-warning-base">
          {perf.error() ?? perf.streamError()}
        </div>
      </Show>

      <SummaryCards summary={summary()} issues={issues()} />
      <RuntimeSupport summary={summary()} />

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ResourceChart
          title="CPU, memory, and event loop"
          description="Runtime pressure from resource samples and timeline aggregates"
          points={resourcePoints(perf.timeline(), summary())}
          datasets={[
            { label: "CPU %", field: "cpu", color: CPU_COLOR },
            { label: "Memory MB", field: "memory", color: MEMORY_COLOR },
            { label: "Event loop p95 ms", field: "eventLoopLag", color: REQUEST_COLOR },
          ]}
          onVisible={() => void perf.loadTimeline(perf.windowMs())}
        />
        <ResourceChart
          title="Requests, sessions, and disk IO"
          description="Request latency with session activity and app-owned disk counters"
          points={requestPoints(perf.timeline(), summary())}
          datasets={[
            { label: "Latency ms", field: "latency", color: CPU_COLOR },
            { label: "Sessions", field: "activeSessions", color: MEMORY_COLOR },
            { label: "Disk ops", field: "diskOps", color: DISK_COLOR },
          ]}
          onVisible={() => void perf.loadTimeline(perf.windowMs())}
        />
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Timeline traces={traces()} onSelect={(trace) => void selectTrace(trace.traceId, trace)} />
        <IssueList
          issues={issues()}
          onTrace={(issue) => issue.traceId && void selectTrace(issue.traceId, issueTraceFallback(issue))}
        />
      </div>

      <TopRankings
        summary={summary()}
        onTrace={(item) => item.traceId && void selectTrace(item.traceId, rankedTraceFallback(item))}
      />
      <BrowserMetricsChart samples={perf.browserSamples()} />
      <FrontendSection summary={summary()} />
      <TraceDrawer
        trace={selectedTrace()}
        detail={selectedTraceDetail()}
        onClose={() => {
          setSelectedTrace(null)
          setSelectedTraceDetail(null)
        }}
      />
    </div>
  )
}

function TimeRangeControl(props: { value: number; onChange: (value: number) => void }) {
  return (
    <div class="flex items-center rounded-lg bg-surface-inset-base p-1">
      <For each={TIME_RANGES}>
        {(range) => (
          <button
            type="button"
            classList={{
              "rounded-md px-2.5 py-1 text-11-medium transition-colors": true,
              "bg-surface-raised-base text-text-strong shadow-sm": props.value === range.value,
              "text-text-weak hover:text-text-base": props.value !== range.value,
            }}
            onClick={() => props.onChange(range.value)}
          >
            {range.label}
          </button>
        )}
      </For>
    </div>
  )
}

function SummaryCards(props: { summary: PerformanceSummary | null | undefined; issues: PerformanceIssue[] }) {
  const summary = () => props.summary
  const resources = () => summary()?.resources
  const frontend = () => summary()?.frontend
  return (
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Health" value={summary()?.health.status ?? "Unknown"} icon="perf.health" />
      <MetricCard label="HTTP p95" value={formatDuration(summary()?.backend.p95RequestMs)} icon="perf.latency" />
      <MetricCard
        label="Sessions"
        value={`${summary()?.backend.activeSessions ?? 0} active · ${summary()?.backend.pendingSessions ?? 0} pending`}
        icon="perf.trace"
      />
      <MetricCard
        label="Issues"
        value={String(props.issues.length)}
        icon="perf.issue"
        tone={props.issues.length > 0 ? "warning" : "default"}
      />
      <MetricCard label="CPU" value={formatPercent(ratioToPercent(resources()?.cpuUtilizationRatio))} icon="perf.cpu" />
      <MetricCard label="Memory" value={formatBytes(resources()?.rssBytes)} icon="perf.memory" />
      <MetricCard label="Event loop p95" value={formatDuration(resources()?.eventLoopLagP95Ms)} icon="perf.latency" />
      <MetricCard
        label="Disk IO"
        value={`${formatBytes(resources()?.appReadBytes)} read · ${formatBytes(resources()?.appWrittenBytes)} write`}
        icon="perf.disk"
      />
      <MetricCard
        label="Disk ops"
        value={`${resources()?.appReadOps ?? 0} read · ${resources()?.appWriteOps ?? 0} write`}
        icon="perf.disk"
      />
      <MetricCard label="LLM calls" value={String(summary()?.sessions?.llmCallCount ?? 0)} icon="perf.network" />
      <MetricCard label="Tool calls" value={String(summary()?.sessions?.toolCallCount ?? 0)} icon="perf.trace" />
      <MetricCard label="Long tasks" value={String(frontend()?.longTaskCount ?? 0)} icon="perf.frontend" />
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

function RuntimeSupport(props: { summary: PerformanceSummary | null | undefined }) {
  return (
    <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("perf.health")} size="small" class="text-icon-weak" />
        <div>
          <h3 class="text-14-semibold text-text-strong">Runtime health and support</h3>
          <p class="mt-1 text-11-regular text-text-weak">
            Diagnostics-derived support signals for lock health, trace evidence, recent errors, and pending sessions.
          </p>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-2 md:grid-cols-4">
        <For each={runtimeSupportItems(props.summary)}>
          {(item) => (
            <div class="rounded-lg bg-surface-inset-base/70 px-3 py-2">
              <div class="text-10-medium uppercase tracking-[0.1em] text-text-weaker">{item.label}</div>
              <div
                classList={{
                  "mt-1 text-13-medium text-text-strong tabular-nums": true,
                  "text-icon-warning-base": item.tone === "warning",
                  "text-icon-success-base": item.tone === "success",
                }}
              >
                {item.value}
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function ResourceChart(props: {
  title: string
  description: string
  points: PerformanceMetricPoint[]
  datasets: Array<{ label: string; field: keyof PerformanceMetricPoint; color: string }>
  onVisible?: () => void
}) {
  let element: HTMLDivElement | undefined
  let visible = false
  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver((entries) => {
      if (visible || !entries.some((entry) => entry.isIntersecting)) return
      visible = true
      props.onVisible?.()
      observer.disconnect()
    })
    queueMicrotask(() => element && observer.observe(element))
    onCleanup(() => observer.disconnect())
  } else {
    queueMicrotask(() => props.onVisible?.())
  }
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
    <div ref={element} class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
      <div class="mb-3">
        <h3 class="text-14-semibold text-text-strong">{props.title}</h3>
        <p class="mt-1 text-11-regular text-text-weak">{props.description}</p>
      </div>
      <Show when={props.points.length > 0} fallback={<EmptyState label="No samples yet" />}>
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
                  <div class="truncate text-11-regular text-text-weaker">
                    {[trace.kind, trace.module, trace.traceId].filter(Boolean).join(" · ")}
                  </div>
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

function IssueList(props: { issues: PerformanceIssue[]; onTrace: (issue: PerformanceIssue) => void }) {
  return (
    <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("perf.issue")} size="small" class="text-icon-weak" />
        <h3 class="text-14-semibold text-text-strong">Performance issues</h3>
      </div>
      <Show when={props.issues.length > 0} fallback={<EmptyState label="No active performance issues" />}>
        <div class="flex flex-col gap-2">
          <For each={props.issues}>
            {(issue) => {
              const content = (
                <>
                  <div class="flex items-center justify-between gap-3">
                    <div class="truncate text-12-medium text-text-strong">
                      {issue.title ?? issue.message ?? "Performance issue"}
                    </div>
                    <span class={severityClass(issue.severity)}>{issue.severity ?? "info"}</span>
                  </div>
                  <div class="mt-1 line-clamp-2 text-11-regular text-text-weak">{issue.message}</div>
                  <div class="mt-1 text-11-regular text-text-weaker">
                    {[issue.module, formatTime(issue.lastSeenTime), issue.traceId ? "trace available" : undefined]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </>
              )
              return issue.traceId ? (
                <button
                  type="button"
                  class="rounded-lg bg-surface-inset-base/70 p-3 text-left transition-colors hover:bg-surface-hover-base"
                  onClick={() => props.onTrace(issue)}
                >
                  {content}
                </button>
              ) : (
                <div class="rounded-lg bg-surface-inset-base/70 p-3">{content}</div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

function TopRankings(props: { summary: PerformanceSummary | null | undefined; onTrace: (item: RankedItem) => void }) {
  const groups = createMemo(() => {
    const top = props.summary?.top
    return [
      { title: "Slow routes", icon: "perf.routes" as const, items: top?.slowRoutes ?? [] },
      { title: "Slow sessions", icon: "perf.sessions" as const, items: top?.slowSessions ?? [] },
      { title: "Slow tools", icon: "perf.tools" as const, items: top?.slowTools ?? [] },
      { title: "Slow providers", icon: "perf.providers" as const, items: top?.slowProviders ?? [] },
      { title: "Slow storage", icon: "perf.storage" as const, items: top?.slowStorage ?? [] },
      { title: "Slow library", icon: "perf.library" as const, items: top?.slowLibrary ?? [] },
    ]
  })
  return (
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <For each={groups()}>
        {(group) => (
          <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
            <div class="mb-3 flex items-center gap-2">
              <Icon name={getSemanticIcon(group.icon)} size="small" class="text-icon-weak" />
              <h3 class="text-14-semibold text-text-strong">{group.title}</h3>
            </div>
            <Show when={group.items.length > 0} fallback={<EmptyState label="No slow items in this range" />}>
              <div class="flex flex-col gap-1.5">
                <For each={group.items}>
                  {(item) => (
                    <button
                      type="button"
                      class="flex items-center gap-3 rounded-lg bg-surface-inset-base/70 px-3 py-2 text-left transition-colors hover:bg-surface-hover-base disabled:cursor-default disabled:hover:bg-surface-inset-base/70"
                      disabled={!item.traceId}
                      onClick={() => props.onTrace(item)}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-12-medium text-text-strong">{item.label}</div>
                        <div class="truncate text-11-regular text-text-weaker">
                          {[item.module, item.sessionID, item.tool].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <div class="text-11-medium text-text-weak tabular-nums">
                        {formatMetricValue(item.value, item.unit)}
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}

function BrowserMetricsChart(props: { samples: BrowserMetricSample[] }) {
  return (
    <ResourceChart
      title="Browser metrics"
      description="Client-side DOM, navigation, and heap samples collected by this performance view"
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
  )
}

function FrontendSection(props: { summary: PerformanceSummary | null | undefined }) {
  const frontend = () => props.summary?.frontend
  const slow = () => props.summary?.top.slowFrontend ?? []
  return (
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
        <div class="mb-3 flex items-center gap-2">
          <Icon name={getSemanticIcon("perf.frontend")} size="small" class="text-icon-weak" />
          <h3 class="text-14-semibold text-text-strong">Slow frontend</h3>
        </div>
        <Show when={slow().length > 0} fallback={<EmptyState label="No slow frontend routes in this range" />}>
          <div class="flex flex-col gap-1.5">
            <For each={slow()}>
              {(item) => (
                <div class="flex items-center gap-3 rounded-lg bg-surface-inset-base/70 px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-12-medium text-text-strong">{item.label}</div>
                    <div class="truncate text-11-regular text-text-weaker">{item.module}</div>
                  </div>
                  <div class="text-11-medium text-text-weak tabular-nums">
                    {formatMetricValue(item.value, item.unit)}
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="rounded-xl border border-border-weaker-base bg-surface-raised-base p-4">
        <div class="mb-3 flex items-center gap-2">
          <Icon name={getSemanticIcon("perf.vitals")} size="small" class="text-icon-weak" />
          <h3 class="text-14-semibold text-text-strong">Frontend vitals</h3>
        </div>
        <div class="grid grid-cols-2 gap-2 text-12-regular">
          <Vital label="INP" value={formatDuration(frontend()?.inpMs)} />
          <Vital label="LCP" value={formatDuration(frontend()?.lcpMs)} />
          <Vital label="CLS" value={formatDecimal(frontend()?.cls)} />
          <Vital label="FCP" value={formatDuration(frontend()?.fcpMs)} />
          <Vital label="TTFB" value={formatDuration(frontend()?.ttfbMs)} />
          <Vital label="Resource p95" value={formatDuration(frontend()?.resourceP95Ms)} />
          <Vital label="Long tasks" value={String(frontend()?.longTaskCount ?? 0)} />
        </div>
      </div>
    </div>
  )
}

function Vital(props: { label: string; value: string }) {
  return (
    <div class="rounded-lg bg-surface-inset-base/70 px-3 py-2">
      <div class="text-10-medium uppercase tracking-[0.1em] text-text-weaker">{props.label}</div>
      <div class="mt-1 text-13-medium text-text-strong tabular-nums">{props.value}</div>
    </div>
  )
}

function TraceDrawer(props: {
  trace: PerformanceTraceSpan | null
  detail: PerformanceTraceDetail | null
  onClose: () => void
}) {
  return (
    <KobalteDialog open={props.trace !== null} onOpenChange={(open) => !open && props.onClose()}>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay data-component="dialog-overlay" />
        <div data-component="dialog" data-size="content" data-placement="center">
          <div data-slot="dialog-container">
            <KobalteDialog.Content data-slot="dialog-content">
              <div data-slot="dialog-header">
                <div class="min-w-0">
                  <Show
                    when={props.trace}
                    fallback={<KobalteDialog.Title data-slot="dialog-title">Trace Detail</KobalteDialog.Title>}
                  >
                    {(trace) => <KobalteDialog.Title data-slot="dialog-title">{trace().name}</KobalteDialog.Title>}
                  </Show>
                </div>
                <KobalteDialog.CloseButton
                  data-slot="dialog-close-button"
                  data-component="icon-button"
                  data-variant="ghost"
                >
                  <Icon name={getSemanticIcon("action.close")} size="small" />
                </KobalteDialog.CloseButton>
              </div>
              <KobalteDialog.Description data-slot="dialog-description">
                {props.trace?.traceId}
              </KobalteDialog.Description>
              <div data-slot="dialog-body">
                <Show when={props.trace}>
                  {(trace) => (
                    <div class="flex flex-col gap-3 text-12-regular">
                      <DetailRow label="Status" value={trace().status ?? "unknown"} />
                      <DetailRow label="Duration" value={formatDuration(trace().durationMs)} />
                      <DetailRow label="Module" value={trace().module ?? "—"} />
                      <DetailRow label="Session" value={trace().sessionID ?? "—"} />
                      <DetailRow label="Start" value={formatTime(trace().startedAt)} />
                      <DetailRow label="End" value={formatTime(trace().endedAt)} />
                      <Show when={trace().errorCode}>
                        <div class="rounded-lg bg-surface-inset-base/70 p-3 text-icon-warning-base">
                          {trace().errorCode}
                        </div>
                      </Show>
                      <Show when={props.detail?.spans.length}>
                        <div>
                          <div class="mb-2 text-11-medium uppercase tracking-[0.12em] text-text-weaker">Spans</div>
                          <div class="flex flex-col gap-1.5">
                            <For each={props.detail?.spans ?? []}>
                              {(span) => (
                                <div class="rounded-lg bg-surface-inset-base/70 px-3 py-2">
                                  <div class="truncate text-12-medium text-text-strong">{span.name}</div>
                                  <div class="mt-1 text-11-regular text-text-weaker">
                                    {[span.module, span.status, formatDuration(span.durationMs)]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                      <Show when={props.detail?.events.length}>
                        <div>
                          <div class="mb-2 text-11-medium uppercase tracking-[0.12em] text-text-weaker">Events</div>
                          <div class="flex flex-col gap-1.5">
                            <For each={(props.detail?.events ?? []).slice(0, 20)}>
                              {(event) => (
                                <div class="rounded-lg bg-surface-inset-base/70 px-3 py-2">
                                  <div class="truncate text-12-medium text-text-strong">{event.type}</div>
                                  <div class="mt-1 text-11-regular text-text-weaker">
                                    {formatTime(event.iso ?? event.time)}
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </KobalteDialog.Content>
          </div>
        </div>
      </KobalteDialog.Portal>
    </KobalteDialog>
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

function resourcePoints(
  timeline: PerformanceTimeline | null | undefined,
  summary?: PerformanceSummary | null,
): PerformanceMetricPoint[] {
  const points = pointsFromTimeline(timeline, {
    "process.cpu.utilization": (value, point) => ({ ...point, cpu: ratioToPercent(value) }),
    "process.memory.rss": (value, point) => ({ ...point, memory: value / 1024 / 1024 }),
    "process.event_loop.lag": (value, point) => ({ ...point, eventLoopLag: value }),
  })
  if (points.length > 0) return points
  if (!summary?.resources) return []
  return [
    {
      timestamp: summary.generatedAt,
      cpu: ratioToPercent(summary.resources.cpuUtilizationRatio),
      memory: summary.resources.rssBytes ? summary.resources.rssBytes / 1024 / 1024 : undefined,
      eventLoopLag: summary.resources.eventLoopLagP95Ms,
    },
  ]
}

function requestPoints(
  timeline: PerformanceTimeline | null | undefined,
  summary?: PerformanceSummary | null,
): PerformanceMetricPoint[] {
  const points = pointsFromTimeline(timeline, {
    "http.request.duration": (value, point) => ({ ...point, latency: value }),
  })
  const diskOps = (summary?.resources.appReadOps ?? 0) + (summary?.resources.appWriteOps ?? 0)
  if (points.length > 0) {
    return points.map((point) => ({ ...point, activeSessions: summary?.backend.activeSessions, diskOps }))
  }
  if (!summary?.backend) return []
  return [
    {
      timestamp: summary.generatedAt,
      requests: summary.backend.requestCount,
      latency: summary.backend.p95RequestMs,
      activeSessions: summary.backend.activeSessions,
      diskOps,
    },
  ]
}

function pointsFromTimeline(
  timeline: PerformanceTimeline | null | undefined,
  mappers: Record<string, (value: number, point: PerformanceMetricPoint) => PerformanceMetricPoint>,
): PerformanceMetricPoint[] {
  if (!timeline?.series.length) return []
  const byTime = new Map<number, PerformanceMetricPoint>()
  for (const series of timeline.series) {
    const mapValue = mappers[series.name]
    if (!mapValue) continue
    for (const item of series.points) {
      if (item.value === null) continue
      const current = byTime.get(item.time) ?? { timestamp: item.time }
      byTime.set(item.time, mapValue(item.value, current))
    }
  }
  return [...byTime.values()].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
}

function issueTraceFallback(issue: PerformanceIssue): Partial<PerformanceTraceSpan> {
  return {
    name: issue.title ?? issue.message ?? "Performance issue",
    status: issue.severity === "critical" || issue.severity === "error" ? "error" : "ok",
    startedAt: new Date(issue.firstSeenTime).toISOString(),
    durationMs: Math.max(0, issue.lastSeenTime - issue.firstSeenTime),
    module: issue.module,
    sessionID: issue.sessionID,
    redactionApplied: true,
  }
}

function rankedTraceFallback(item: RankedItem): Partial<PerformanceTraceSpan> {
  return {
    name: item.label,
    status: item.status === "error" || item.status === "cancelled" || item.status === "timeout" ? item.status : "ok",
    durationMs: item.unit === "ms" ? item.value : undefined,
    module: item.module,
    sessionID: item.sessionID,
    redactionApplied: true,
  }
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
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`
  return `${value.toFixed(0)} B`
}

function formatDuration(value?: number): string {
  if (value === undefined) return "—"
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
  return `${value.toFixed(0)}ms`
}

function formatDecimal(value?: number): string {
  if (value === undefined) return "—"
  return value.toFixed(value >= 1 ? 2 : 3)
}

function formatMetricValue(value: number, unit: string): string {
  if (unit === "ms") return formatDuration(value)
  if (unit === "bytes") return formatBytes(value)
  if (unit === "ratio") return formatPercent(ratioToPercent(value))
  return value.toFixed(value >= 10 ? 0 : 1)
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
