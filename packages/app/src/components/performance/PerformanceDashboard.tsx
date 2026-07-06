import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Line } from "solid-chartjs"
import { Chart as ChartJS, CategoryScale, Filler, LinearScale, LineElement, PointElement, Tooltip } from "chart.js"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import {
  browserMetricPoints,
  buildLineChartModel,
  formatBytes as formatChartBytes,
  formatDuration as formatChartDuration,
  formatMetricValue as formatChartMetricValue,
  formatPercent as formatChartPercent,
  memoryPoints,
  requestPoints as requestTimelinePoints,
  resourcePressurePoints,
  ratioToPercent,
  sessionPoints,
  storagePoints,
  summaryQualityMessage,
  type ChartDatasetSpec,
} from "./chart-model"
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
    <div class="performance-dashboard">
      <div class="performance-toolbar flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
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
        <div class="performance-card rounded-xl px-4 py-3 text-12-regular text-icon-warning-base">
          {perf.error() ?? perf.streamError()}
        </div>
      </Show>

      <SummaryQualityNotice summary={summary()} />
      <SummaryCards summary={summary()} issues={issues()} />
      <RuntimeSupport summary={summary()} />

      <div class="performance-chart-grid">
        <PerformanceLineChart
          title="CPU and event loop"
          description="CPU average percent and event-loop p95 latency from runtime timeline buckets"
          points={resourcePressurePoints(perf.timeline())}
          datasets={[
            percentDataset("CPU", "cpu", CPU_COLOR, "Timeline process.cpu.utilization"),
            durationDataset("Event loop", "eventLoopLag", REQUEST_COLOR, "Timeline process.event_loop.lag", "p95"),
          ]}
          quality={timelineQuality(perf.timeline(), ["process.cpu.utilization", "process.event_loop.lag"])}
          onVisible={() => void perf.loadTimeline(perf.windowMs())}
        />
        <PerformanceLineChart
          title="Memory"
          description="RSS, heap used, and heap total as memory gauges in MB"
          points={memoryPoints(perf.timeline(), summary())}
          datasets={[
            megabytesDataset("RSS", "memory", MEMORY_COLOR, "Timeline process.memory.rss"),
            megabytesDataset("Heap used", "heapUsed", BROWSER_COLOR, "Timeline process.memory.heap_used"),
            megabytesDataset("Heap total", "heapTotal", DISK_COLOR, "Timeline process.memory.heap_total"),
          ]}
          quality={timelineQuality(perf.timeline(), [
            "process.memory.rss",
            "process.memory.heap_used",
            "process.memory.heap_total",
          ])}
          onVisible={() => void perf.loadTimeline(perf.windowMs())}
        />
        <PerformanceLineChart
          title="Requests"
          description="HTTP request p95 latency with request sample count per bucket"
          points={requestTimelinePoints(perf.timeline())}
          datasets={[
            durationDataset("Request", "latency", CPU_COLOR, "Timeline http.request.duration", "p95"),
            countDataset(
              "Requests / bucket",
              "requests",
              REQUEST_COLOR,
              "Bucket sample count for http.request.duration",
            ),
          ]}
          quality={timelineQuality(perf.timeline(), ["http.request.duration"])}
          onVisible={() => void perf.loadTimeline(perf.windowMs())}
        />
        <PerformanceLineChart
          title="Sessions"
          description="Only real session timeline metrics are shown; current active sessions remain in summary cards"
          points={sessionPoints(perf.timeline())}
          datasets={[
            countDataset("Active turns", "activeSessions", MEMORY_COLOR, "Timeline session.turn.active"),
            durationDataset("Turn", "latency", BROWSER_COLOR, "Timeline session.turn.duration", "p95"),
          ]}
          quality={timelineQuality(perf.timeline(), ["session.turn.active", "session.turn.duration"])}
          emptyLabel="No historical session samples for this range"
          onVisible={() => void perf.loadTimeline(perf.windowMs())}
        />
        <PerformanceLineChart
          title="Storage I/O"
          description="Storage operation counts and p95 latency from emitted storage metrics"
          points={storagePoints(perf.timeline())}
          datasets={[
            countDataset("Operations / bucket", "diskOps", DISK_COLOR, "Timeline storage.operation.count"),
            durationDataset("Operation", "latency", REQUEST_COLOR, "Timeline storage.operation.duration", "p95"),
            bytesDataset("Read bytes / bucket", "readBytes", MEMORY_COLOR, "Timeline storage.read.bytes"),
            bytesDataset("Write bytes / bucket", "writeBytes", BROWSER_COLOR, "Timeline storage.write.bytes"),
          ]}
          quality={timelineQuality(perf.timeline(), [
            "storage.operation.count",
            "storage.operation.duration",
            "storage.read.bytes",
            "storage.write.bytes",
          ])}
          emptyLabel="Storage metrics are not available for this range"
          onVisible={() => void perf.loadTimeline(perf.windowMs())}
        />
      </div>

      <div class="performance-split-grid">
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
    <div class="performance-control flex items-center rounded-lg p-1">
      <For each={TIME_RANGES}>
        {(range) => (
          <button
            type="button"
            classList={{
              "rounded-md px-2.5 py-1 text-11-medium transition-colors": true,
              "workbench-selected-surface text-text-strong shadow-sm": props.value === range.value,
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

function SummaryQualityNotice(props: { summary: PerformanceSummary | null | undefined }) {
  return (
    <Show when={summaryQualityMessage(props.summary)}>
      {(message) => (
        <div class="performance-card rounded-xl px-4 py-3 text-12-regular text-icon-warning-base">{message()}</div>
      )}
    </Show>
  )
}

function SummaryCards(props: { summary: PerformanceSummary | null | undefined; issues: PerformanceIssue[] }) {
  const summary = () => props.summary
  const resources = () => summary()?.resources
  const frontend = () => summary()?.frontend
  return (
    <div class="performance-summary-grid">
      <MetricCard label="Health" value={summary()?.health.status ?? "Unknown"} icon="performance.health" />
      <MetricCard
        label="HTTP p95"
        value={formatChartDuration(summary()?.backend.p95RequestMs)}
        icon="performance.latency"
      />
      <MetricCard
        label="Sessions"
        value={`${summary()?.backend.activeSessions ?? 0} active · ${summary()?.backend.pendingSessions ?? 0} pending`}
        icon="performance.trace"
      />
      <MetricCard
        label="Issues"
        value={String(props.issues.length)}
        icon="performance.issue"
        tone={props.issues.length > 0 ? "warning" : "default"}
      />
      <MetricCard
        label="CPU"
        value={formatChartPercent(ratioToPercent(resources()?.cpuUtilizationRatio))}
        icon="performance.cpu"
      />
      <MetricCard label="Memory" value={formatChartBytes(resources()?.rssBytes)} icon="performance.memory" />
      <MetricCard
        label="Event loop p95"
        value={formatChartDuration(resources()?.eventLoopLagP95Ms)}
        icon="performance.latency"
      />
      <MetricCard
        label="Disk IO"
        value={`${formatChartBytes(resources()?.appReadBytes)} read · ${formatChartBytes(resources()?.appWrittenBytes)} write`}
        icon="performance.disk"
      />
      <MetricCard
        label="Disk ops"
        value={`${resources()?.appReadOps ?? 0} read · ${resources()?.appWriteOps ?? 0} write`}
        icon="performance.disk"
      />
      <MetricCard label="LLM calls" value={String(summary()?.sessions?.llmCallCount ?? 0)} icon="performance.network" />
      <MetricCard label="Tool calls" value={String(summary()?.sessions?.toolCallCount ?? 0)} icon="performance.trace" />
      <MetricCard label="Long tasks" value={String(frontend()?.longTaskCount ?? 0)} icon="performance.frontend" />
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
    <div class="performance-card rounded-xl p-4">
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
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.health")} size="small" class="text-icon-weak" />
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
            <div class="performance-card-soft rounded-lg px-3 py-2">
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

function PerformanceLineChart(props: {
  title: string
  description: string
  points: PerformanceMetricPoint[]
  datasets: ChartDatasetSpec[]
  quality?: string
  emptyLabel?: string
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
  const model = createMemo(() => buildLineChartModel({ points: props.points, datasets: props.datasets }))

  return (
    <div ref={element} class="performance-card rounded-xl p-4">
      <div class="mb-3">
        <h3 class="text-14-semibold text-text-strong">{props.title}</h3>
        <p class="mt-1 text-11-regular text-text-weak">{props.description}</p>
        <Show when={props.quality}>
          {(quality) => <p class="mt-1 text-11-regular text-icon-warning-base">{quality()}</p>}
        </Show>
      </div>
      <Show
        when={hasVisibleChartData(props.points, props.datasets)}
        fallback={<EmptyState label={props.emptyLabel ?? "No samples yet"} />}
      >
        <div class="h-56">
          <Line data={model().data} options={model().options} />
        </div>
      </Show>
    </div>
  )
}

function Timeline(props: { traces: PerformanceTraceSpan[]; onSelect: (trace: PerformanceTraceSpan) => void }) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.timeline")} size="small" class="text-icon-weak" />
        <h3 class="text-14-semibold text-text-strong">Trace timeline</h3>
      </div>
      <Show when={props.traces.length > 0} fallback={<EmptyState label="No trace spans reported" />}>
        <div class="flex flex-col gap-2">
          <For each={props.traces}>
            {(trace) => (
              <button
                type="button"
                class="performance-card-soft flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover-base"
                onClick={() => props.onSelect(trace)}
              >
                <div class="h-2 w-2 shrink-0 rounded-full bg-icon-accent-base" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-12-medium text-text-strong">{trace.name}</div>
                  <div class="truncate text-11-regular text-text-weaker">
                    {[trace.kind, trace.module, trace.traceId].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div class="text-11-medium text-text-weak tabular-nums">{formatChartDuration(trace.durationMs)}</div>
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
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.issue")} size="small" class="text-icon-weak" />
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
                  class="performance-card-soft rounded-lg p-3 text-left transition-colors hover:bg-surface-hover-base"
                  onClick={() => props.onTrace(issue)}
                >
                  {content}
                </button>
              ) : (
                <div class="performance-card-soft rounded-lg p-3">{content}</div>
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
      { title: "Slow routes", icon: "performance.routes" as const, items: top?.slowRoutes ?? [] },
      { title: "Slow sessions", icon: "performance.sessions" as const, items: top?.slowSessions ?? [] },
      { title: "Slow tools", icon: "performance.tools" as const, items: top?.slowTools ?? [] },
      { title: "Slow providers", icon: "performance.providers" as const, items: top?.slowProviders ?? [] },
      { title: "Slow storage", icon: "performance.storage" as const, items: top?.slowStorage ?? [] },
      { title: "Slow library", icon: "performance.library" as const, items: top?.slowLibrary ?? [] },
    ]
  })
  return (
    <div class="performance-rankings-grid">
      <For each={groups()}>
        {(group) => (
          <div class="performance-card rounded-xl p-4">
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
                      class="performance-card-soft flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover-base disabled:cursor-default disabled:opacity-60"
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
                        {formatChartMetricValue(item.value, item.unit)}
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
  const points = createMemo(() => browserMetricPoints(props.samples))
  const memoryUnsupported = createMemo(
    () => props.samples.length > 0 && props.samples.every((sample) => sample.memory === undefined),
  )
  return (
    <PerformanceLineChart
      title="Local browser samples"
      description="Local DOM, navigation, and heap samples collected by this Performance view, separate from stored frontend telemetry"
      points={points()}
      datasets={[
        megabytesDataset("Heap used", "memory", BROWSER_COLOR, "Local performance.memory sample"),
        countDataset("DOM nodes", "domNodes", MEMORY_COLOR, "Local DOM sample"),
        durationDataset("Navigation duration", "latency", REQUEST_COLOR, "Local navigation timing sample"),
      ]}
      quality={memoryUnsupported() ? "Browser memory API is unavailable in this browser." : undefined}
    />
  )
}

function FrontendSection(props: { summary: PerformanceSummary | null | undefined }) {
  const frontend = () => props.summary?.frontend
  const slow = () => props.summary?.top.slowFrontend ?? []
  return (
    <div class="performance-frontend-grid">
      <div class="performance-card rounded-xl p-4">
        <div class="mb-3 flex items-center gap-2">
          <Icon name={getSemanticIcon("performance.frontend")} size="small" class="text-icon-weak" />
          <h3 class="text-14-semibold text-text-strong">Slow frontend</h3>
        </div>
        <Show when={slow().length > 0} fallback={<EmptyState label="No slow frontend routes in this range" />}>
          <div class="flex flex-col gap-1.5">
            <For each={slow()}>
              {(item) => (
                <div class="performance-card-soft flex items-center gap-3 rounded-lg px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-12-medium text-text-strong">{item.label}</div>
                    <div class="truncate text-11-regular text-text-weaker">{item.module}</div>
                  </div>
                  <div class="text-11-medium text-text-weak tabular-nums">
                    {formatChartMetricValue(item.value, item.unit)}
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="performance-card rounded-xl p-4">
        <div class="mb-3 flex items-center gap-2">
          <Icon name={getSemanticIcon("performance.vitals")} size="small" class="text-icon-weak" />
          <h3 class="text-14-semibold text-text-strong">Frontend vitals</h3>
        </div>
        <div class="grid grid-cols-2 gap-2 text-12-regular">
          <Vital label="INP" value={formatChartDuration(frontend()?.inpMs)} />
          <Vital label="LCP" value={formatChartDuration(frontend()?.lcpMs)} />
          <Vital label="CLS" value={formatDecimal(frontend()?.cls)} />
          <Vital label="FCP" value={formatChartDuration(frontend()?.fcpMs)} />
          <Vital label="TTFB" value={formatChartDuration(frontend()?.ttfbMs)} />
          <Vital label="Resource p95" value={formatChartDuration(frontend()?.resourceP95Ms)} />
          <Vital label="Long tasks" value={String(frontend()?.longTaskCount ?? 0)} />
        </div>
      </div>
    </div>
  )
}

function Vital(props: { label: string; value: string }) {
  return (
    <div class="performance-card-soft rounded-lg px-3 py-2">
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
                      <DetailRow label="Duration" value={formatChartDuration(trace().durationMs)} />
                      <DetailRow label="Module" value={trace().module ?? "—"} />
                      <DetailRow label="Session" value={trace().sessionID ?? "—"} />
                      <DetailRow label="Start" value={formatTime(trace().startedAt)} />
                      <DetailRow label="End" value={formatTime(trace().endedAt)} />
                      <Show when={trace().errorCode}>
                        <div class="performance-card-soft rounded-lg p-3 text-icon-warning-base">
                          {trace().errorCode}
                        </div>
                      </Show>
                      <Show when={props.detail?.spans.length}>
                        <div>
                          <div class="mb-2 text-11-medium uppercase tracking-[0.12em] text-text-weaker">Spans</div>
                          <div class="flex flex-col gap-1.5">
                            <For each={props.detail?.spans ?? []}>
                              {(span) => (
                                <div class="performance-card-soft rounded-lg px-3 py-2">
                                  <div class="truncate text-12-medium text-text-strong">{span.name}</div>
                                  <div class="mt-1 text-11-regular text-text-weaker">
                                    {[span.module, span.status, formatChartDuration(span.durationMs)]
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
                                <div class="performance-card-soft rounded-lg px-3 py-2">
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
    <div class="flex items-center justify-between gap-3 border-b border-border-weaker-base/70 pb-2">
      <span class="text-text-weaker">{props.label}</span>
      <span class="truncate text-text-base">{props.value}</span>
    </div>
  )
}

function EmptyState(props: { label: string }) {
  return (
    <div class="performance-card-soft rounded-lg px-3 py-8 text-center text-12-regular text-text-weaker">
      {props.label}
    </div>
  )
}

function percentDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: string,
  source: string,
): ChartDatasetSpec {
  return {
    label,
    field,
    color,
    source,
    unit: "percent",
    stat: "avg",
    axisId: "percent",
    axisTitle: "Percent",
    formatter: formatChartPercent,
  }
}

function durationDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: string,
  source: string,
  stat?: string,
): ChartDatasetSpec {
  return {
    label,
    field,
    color,
    source,
    unit: "ms",
    stat,
    axisId: "duration",
    axisTitle: "Milliseconds",
    formatter: formatChartDuration,
  }
}

function megabytesDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: string,
  source: string,
): ChartDatasetSpec {
  return {
    label,
    field,
    color,
    source,
    unit: "megabytes",
    stat: "latest",
    axisId: "memory",
    axisTitle: "Memory (MB)",
    formatter: (value) => `${value.toFixed(value >= 10 ? 0 : 1)} MB`,
  }
}

function countDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: string,
  source: string,
): ChartDatasetSpec {
  return {
    label,
    field,
    color,
    source,
    unit: "count",
    stat: label.includes("bucket") ? "count" : "latest",
    axisId: "count",
    axisTitle: "Count",
    formatter: (value) => value.toFixed(value >= 10 ? 0 : 1),
  }
}

function bytesDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: string,
  source: string,
): ChartDatasetSpec {
  return {
    label,
    field,
    color,
    source,
    unit: "bytes",
    stat: "sum",
    axisId: "bytes",
    axisTitle: "Bytes",
    formatter: formatChartBytes,
  }
}

function hasVisibleChartData(points: PerformanceMetricPoint[], datasets: ChartDatasetSpec[]) {
  return points.some((point) =>
    datasets.some(
      (dataset) => typeof point[dataset.field] === "number" && Number.isFinite(point[dataset.field] as number),
    ),
  )
}

function timelineQuality(timeline: PerformanceTimeline | null | undefined, metrics: string[]) {
  if (!timeline) return undefined
  if (timeline.quality?.truncated || timeline.quality?.partial)
    return "Timeline data is partial because the metric volume exceeded the dashboard cap."
  const related = timeline.series.filter((series) => metrics.includes(series.name))
  if (!related.length) return "Metrics are not available for this range."
  if (related.every((series) => (series.sampleCount ?? 0) === 0)) return "Metrics are not available for this range."
  if (related.some((series) => series.quality?.retentionLimited))
    return "Timeline data is retention-limited for this range."
  return undefined
}

function formatDecimal(value?: number): string {
  if (value === undefined) return "—"
  return value.toFixed(value >= 1 ? 2 : 3)
}

function formatTime(value?: number | string): string {
  if (value === undefined) return ""
  const time = typeof value === "number" ? value : Date.parse(value)
  if (Number.isNaN(time)) return String(value)
  return new Date(time).toLocaleString()
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

function severityClass(severity?: string): string {
  const base = "shrink-0 rounded-full px-2 py-0.5 text-10-medium uppercase tracking-[0.1em]"
  if (severity === "critical" || severity === "error") return `${base} bg-icon-critical-base/15 text-icon-critical-base`
  if (severity === "warning") return `${base} bg-icon-warning-base/15 text-icon-warning-base`
  return `${base} bg-surface-base text-text-weaker`
}
