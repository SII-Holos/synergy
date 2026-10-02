import { createMemo, createSignal, For, Show, onCleanup, type JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Line } from "solid-chartjs"
import { Chart as ChartJS, CategoryScale, Filler, LinearScale, LineElement, PointElement, Tooltip } from "chart.js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { AppPanel } from "@/components/app-panel"
import type { I18n, MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { HexColor } from "@ericsanchezok/synergy-ui/theme"
import { useLocale } from "@/context/locale"
import { useGlobalSDK } from "@/context/global-sdk"
import { useChartTheme } from "../visualization/use-chart-theme"
import {
  isPerformanceAnalysisActive,
  performanceAnalysisSessionPath,
  performanceAnalysisStatusDescriptor,
} from "./analysis-model"
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
import { P } from "./performance-i18n"
import { issueTitle, ISSUE_SEVERITY, traceDisplayName } from "./presentation"
import { performanceSummaryCardModel } from "./summary-card-model"
import { usePerformance } from "./use-performance"
import { PerformanceSnapshotBoundary, SnapshotErrorDetails } from "./snapshot-boundary"
import { runtimeSupportItems } from "./runtime-support"
import { toolFailureCategories, type ToolFailureItem } from "./tool-failure-model"
import type {
  BrowserMetricSample,
  PerformanceAnalysis,
  PerformanceIssue,
  PerformanceMetricPoint,
  PerformanceSummary,
  PerformanceTimeline,
  PerformanceTraceDetail,
  PerformanceTraceSpan,
  PerformanceTracePreview,
} from "./types"

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const TIME_RANGE_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]

type RankedItem = PerformanceSummary["top"]["slowRoutes"][number]

export function PerformanceDashboard() {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const timelineSource = (metric: string) =>
    _({ id: "app.performance.source.timeline", message: "Timeline · {metric}", values: { metric } })
  const perf = usePerformance()
  const chartTheme = useChartTheme()
  const chartColors = createMemo(() => {
    const colors = chartTheme()
    return {
      cpu: colors.series[0],
      memory: colors.series[2],
      request: colors.series[3],
      browser: colors.series[4],
      disk: colors.series[6],
    }
  })
  const [selectedTrace, setSelectedTrace] = createSignal<PerformanceTracePreview | null>(null)
  const [selectedTraceDetail, setSelectedTraceDetail] = createSignal<PerformanceTraceDetail | null>(null)
  const summary = () => perf.summary()
  const issues = createMemo(() => (summary()?.issues ?? []).slice(0, 12))
  const traces = createMemo(() => perf.eventTraces().slice(0, 24))
  const traceLabels = createMemo(() => {
    const labels = new Map<string, string>()
    for (const group of Object.values(summary()?.top ?? {})) {
      for (const item of group) {
        if ("traceId" in item && "label" in item && item.traceId && item.label && !labels.has(item.traceId))
          labels.set(item.traceId, item.label)
      }
    }
    return labels
  })

  const dialog = useDialog()
  const [traceLoading, setTraceLoading] = createSignal(false)
  const [traceError, setTraceError] = createSignal<string>()
  let traceDialog: string | undefined
  let traceRequest = 0
  onCleanup(() => {
    traceRequest++
    if (traceDialog) dialog.close(traceDialog)
  })
  const selectTrace = async (traceId: string, fallback?: Partial<PerformanceTraceSpan>) => {
    const request = ++traceRequest
    setSelectedTrace({ ...fallback, traceId, name: fallback?.name ?? _(P.traceDetail) })
    setSelectedTraceDetail(null)
    setTraceLoading(true)
    setTraceError(undefined)
    if (!traceDialog)
      traceDialog = dialog.show(
        () => (
          <TraceDialog
            _={_}
            fmt={fmt}
            trace={selectedTrace()}
            detail={selectedTraceDetail()}
            loading={traceLoading()}
            error={traceError()}
            onRetry={() => {
              const current = selectedTrace()
              if (current) void selectTrace(current.traceId, current)
            }}
          />
        ),
        () => {
          traceDialog = undefined
          traceRequest++
          setSelectedTrace(null)
          setSelectedTraceDetail(null)
        },
      )
    try {
      const detail = await perf.loadTrace(traceId)
      if (request !== traceRequest || selectedTrace()?.traceId !== traceId) return
      if (!detail || detail.traceId !== traceId)
        throw new Error(_({ id: "app.performance.trace.missingDetail", message: "Trace details are unavailable" }))
      setSelectedTraceDetail(detail)
      const root = detail.root
      if (root)
        setSelectedTrace((previous) =>
          previous
            ? {
                ...previous,
                name: traceDisplayName(root.name, root.attributes),
                status: root.status ?? previous.status,
                startedAt: root.startTime !== undefined ? new Date(root.startTime).toISOString() : previous.startedAt,
                endedAt: root.endTime !== undefined ? new Date(root.endTime).toISOString() : previous.endedAt,
                durationMs: root.durationMs,
                module: root.module,
                sessionID: root.sessionID,
              }
            : null,
        )
    } catch (error) {
      if (request === traceRequest)
        setTraceError(
          error instanceof Error
            ? error.message
            : _({ id: "app.performance.trace.loadFailed", message: "Unable to load trace details" }),
        )
    } finally {
      if (request === traceRequest) setTraceLoading(false)
    }
  }
  const jumpToIssues = () => {
    const section = document.getElementById("performance-diagnostics")
    section?.scrollIntoView({ block: "start" })
    section?.focus({ preventScroll: true })
  }

  return (
    <div class="performance-dashboard">
      <div class="performance-toolbar flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
        <div class="app-panel-caption font-medium text-text-weak">
          {summary()?.generatedAt
            ? _(P.snapshotFrom.id, { time: formatTime(summary()?.generatedAt, fmt) })
            : _(P.snapshotLabel)}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <TimeRangeControl value={perf.windowMs()} onChange={(value) => perf.setWindowMs(value)} />
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("performance.analysis")}
            disabled={
              !summary() ||
              perf.loading ||
              !!perf.error() ||
              perf.analysisStarting() ||
              isPerformanceAnalysisActive(perf.analysis()?.status)
            }
            title={_({
              id: "app.performance.analysis.startHint",
              message: "Create a model diagnosis session for this snapshot",
            })}
            onClick={() => void perf.startAnalysis()}
          >
            {perf.analysisStarting() || isPerformanceAnalysisActive(perf.analysis()?.status)
              ? _(P.analysisAnalyzing)
              : _(P.analysisAnalyze)}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("action.refresh")}
            disabled={perf.loading}
            onClick={() => void perf.refresh()}
          >
            {perf.error() && summary() ? _(P.retry) : _(P.refresh)}
          </Button>
        </div>
      </div>

      <p class="app-panel-caption text-text-weak">
        {_({ id: "app.performance.analysis.startHint", message: "Create a model diagnosis session for this snapshot" })}
      </p>
      <PerformanceAnalysisCard
        _={_}
        analysis={perf.analysis()}
        error={perf.analysisError()}
        starting={perf.analysisStarting()}
        onCancel={() => void perf.cancelAnalysis()}
      />
      <PerformanceSnapshotBoundary
        generatedAt={summary()?.generatedAt}
        attemptedAt={perf.attemptedAt()}
        loading={perf.loading}
        error={perf.error()}
        formatTime={(value) => formatTime(value, fmt)}
        onRetry={() => void perf.refresh()}
      >
        <SummaryQualityNotice _={_} summary={summary()} />
        <SummaryCards _={_} summary={summary()} onIssues={jumpToIssues} />
        <details class="performance-resource-disclosure">
          <summary>{_(P.resourceDetails)}</summary>
          <ResourceOwnership _={_} summary={summary()} />
        </details>

        <Show when={perf.timelineError()}>
          <div class="performance-snapshot-notice" role="alert">
            <p class="app-panel-row-title text-text-strong">{_(P.timelineUnavailable)}</p>
            <SnapshotErrorDetails error={perf.timelineError()!} />
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={perf.timelineLoading()}
              onClick={() => void perf.loadTimeline()}
            >
              {_(P.retry)}
            </Button>
          </div>
        </Show>
        <Show when={perf.timelineLoading()}>
          <p class="app-panel-copy text-text-weak" role="status">
            {_(P.timelineLoading)}
          </p>
        </Show>
        <Show when={perf.timeline() || (!perf.timelineError() && !perf.timelineLoading())}>
          <section class="performance-section" aria-label={_(P.groupResourcePressure)}>
            <h2 class="performance-section-title">{_(P.groupResourcePressure)}</h2>
            <div class="performance-chart-grid">
              {" "}
              <PerformanceLineChart
                _={_}
                title={P.chartCpu}
                description={P.chartCpuDesc}
                points={resourcePressurePoints(perf.timeline())}
                datasets={[
                  percentDataset("CPU", "cpu", chartColors().cpu, timelineSource("process.cpu.utilization")),
                  durationDataset(
                    _({ id: "app.performance.dataset.eventLoop", message: "Event loop" }),
                    "eventLoopLag",
                    chartColors().request,
                    timelineSource("process.event_loop.lag"),
                    "p95",
                  ),
                ]}
                quality={timelineQuality(perf.timeline(), ["process.cpu.utilization", "process.event_loop.lag"])}
              />
              <PerformanceLineChart
                _={_}
                title={P.chartMemory}
                description={P.chartMemoryDesc}
                points={memoryPoints(perf.timeline(), summary())}
                datasets={[
                  megabytesDataset(
                    _(P.datasetRss),
                    "memory",
                    chartColors().memory,
                    timelineSource("process.memory.rss"),
                  ),
                  megabytesDataset(
                    _(P.datasetHeapUsed),
                    "heapUsed",
                    chartColors().browser,
                    timelineSource("process.memory.heap_used"),
                  ),
                  megabytesDataset(
                    _(P.datasetHeapTotal),
                    "heapTotal",
                    chartColors().disk,
                    timelineSource("process.memory.heap_total"),
                  ),
                  megabytesDataset(
                    _(P.datasetExternal),
                    "external",
                    chartColors().request,
                    timelineSource("process.memory.external"),
                  ),
                  megabytesDataset(
                    _(P.datasetArrayBuffers),
                    "arrayBuffers",
                    chartColors().cpu,
                    timelineSource("process.memory.array_buffers"),
                  ),
                ]}
                quality={timelineQuality(perf.timeline(), [
                  "process.memory.rss",
                  "process.memory.heap_used",
                  "process.memory.heap_total",
                  "process.memory.external",
                  "process.memory.array_buffers",
                ])}
              />
            </div>
          </section>
          <section class="performance-section" aria-label={_(P.groupRequests)}>
            <h2 class="performance-section-title">{_(P.groupRequests)}</h2>
            <div class="performance-chart-grid">
              {" "}
              <PerformanceLineChart
                _={_}
                title={P.chartRequests}
                description={P.chartRequestsDesc}
                points={requestTimelinePoints(perf.timeline())}
                datasets={[
                  durationDataset(
                    _({ id: "app.performance.dataset.request", message: "Request" }),
                    "latency",
                    chartColors().cpu,
                    timelineSource("http.request.duration"),
                    "p95",
                  ),
                  countDataset(
                    _({ id: "app.performance.dataset.requestsPerBucket", message: "Requests / bucket" }),
                    "requests",
                    chartColors().request,
                    _({ id: "app.performance.source.requestBuckets", message: "Request samples per timeline bucket" }),
                    _(P.axisCount),
                  ),
                ]}
                quality={timelineQuality(perf.timeline(), ["http.request.duration"])}
              />
              <PerformanceLineChart
                _={_}
                title={P.chartSessions}
                description={P.chartSessionsDesc}
                points={sessionPoints(perf.timeline())}
                datasets={[
                  countDataset(
                    _({ id: "app.performance.dataset.activeTurns", message: "Active turns" }),
                    "activeSessions",
                    chartColors().memory,
                    timelineSource("session.turn.active"),
                    _(P.axisCount),
                  ),
                  durationDataset(
                    _({ id: "app.performance.dataset.turn", message: "Turn" }),
                    "latency",
                    chartColors().browser,
                    timelineSource("session.turn.duration"),
                    "p95",
                  ),
                ]}
                quality={timelineQuality(perf.timeline(), ["session.turn.active", "session.turn.duration"])}
                emptyLabel={P.chartSessionsEmpty}
              />
            </div>
          </section>
          <section class="performance-section" aria-label={_(P.groupStorage)}>
            <h2 class="performance-section-title">{_(P.groupStorage)}</h2>
            <div class="performance-chart-grid">
              {" "}
              <PerformanceLineChart
                _={_}
                title={P.chartStorage}
                description={P.chartStorageDesc}
                points={storagePoints(perf.timeline())}
                datasets={[
                  countDataset(
                    _({ id: "app.performance.dataset.operationsPerBucket", message: "Operations / bucket" }),
                    "diskOps",
                    chartColors().disk,
                    timelineSource("storage.operation.count"),
                    _(P.axisCount),
                  ),
                  durationDataset(
                    _({ id: "app.performance.dataset.operation", message: "Operation" }),
                    "latency",
                    chartColors().request,
                    timelineSource("storage.operation.duration"),
                    "p95",
                  ),
                  bytesDataset(
                    _({ id: "app.performance.dataset.readBytesPerBucket", message: "Read bytes / bucket" }),
                    "readBytes",
                    chartColors().memory,
                    timelineSource("storage.read.bytes"),
                  ),
                  bytesDataset(
                    _({ id: "app.performance.dataset.writeBytesPerBucket", message: "Write bytes / bucket" }),
                    "writeBytes",
                    chartColors().browser,
                    timelineSource("storage.write.bytes"),
                  ),
                ]}
                quality={timelineQuality(perf.timeline(), [
                  "storage.operation.count",
                  "storage.operation.duration",
                  "storage.read.bytes",
                  "storage.write.bytes",
                ])}
                emptyLabel={P.chartStorageEmpty}
              />
            </div>
          </section>
        </Show>

        <section
          class="performance-section"
          id="performance-diagnostics"
          tabindex="-1"
          aria-label={_(P.groupDiagnostics)}
        >
          <h2 class="performance-section-title">{_(P.groupDiagnostics)}</h2>
          <div class="performance-split-grid">
            <div class="performance-detail-group">
              <Show when={perf.tracesError()}>
                <div class="performance-snapshot-notice" role="alert">
                  <p class="app-panel-row-title text-text-strong">{_(P.tracesUnavailable)}</p>
                  <SnapshotErrorDetails error={perf.tracesError()!} />
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={perf.tracesLoading()}
                    onClick={() => void perf.loadTraces()}
                  >
                    {_(P.retry)}
                  </Button>
                </div>
              </Show>
              <Show when={perf.tracesLoading()}>
                <p class="app-panel-copy text-text-weak" role="status">
                  {_(P.tracesLoading)}
                </p>
              </Show>
              <Show when={traces().length || (!perf.tracesLoading() && !perf.tracesError())}>
                <Timeline
                  _={_}
                  traces={traces()}
                  labels={traceLabels()}
                  onSelect={(trace) => void selectTrace(trace.traceId, trace)}
                />
              </Show>
            </div>
            <IssueList
              _={_}
              fmt={fmt}
              issues={issues()}
              onTrace={(issue) => issue.traceId && void selectTrace(issue.traceId, issueTraceFallback(issue))}
            />
          </div>

          <ToolFailures _={_} items={summary()?.top.toolFailures ?? []} />

          <TopRankings
            _={_}
            summary={summary()}
            labels={traceLabels()}
            onTrace={(item) => item.traceId && void selectTrace(item.traceId, rankedTraceFallback(item))}
          />
          <RuntimeSupport _={_} summary={summary()} />
        </section>
        <section class="performance-section" aria-label={_(P.groupBrowser)}>
          <h2 class="performance-section-title">{_(P.groupBrowser)}</h2>
          <BrowserMetricsChart _={_} samples={perf.browserSamples()} />
          <FrontendSection _={_} summary={summary()} stale={Boolean(perf.error())} />
        </section>
      </PerformanceSnapshotBoundary>
    </div>
  )
}

function PerformanceAnalysisCard(props: {
  _: ReturnType<typeof useLingui>["_"]
  analysis: PerformanceAnalysis | null
  error: string | null
  starting: boolean
  onCancel: () => void
}) {
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const analysis = () => props.analysis
  const active = () => isPerformanceAnalysisActive(analysis()?.status)
  const statusTone = () => {
    switch (analysis()?.status) {
      case "completed":
        return "text-text-on-success-base"
      case "error":
        return "text-text-on-critical-base"
      case "interrupted":
        return "text-text-on-warning-base"
      case "running":
        return "text-text-interactive-base"
      default:
        return "text-text-subtle"
    }
  }

  async function openSession(sessionID: string) {
    const response = await globalSDK.client.session.get({ sessionID }).catch(() => undefined)
    const session = response?.data
    if (!session) return
    const path = performanceAnalysisSessionPath({ sessionID, scope: session.scope })
    if (path) navigate(path, { state: { from: window.location.pathname } })
  }

  return (
    <Show when={props.starting || props.error || analysis()}>
      <section class="performance-card rounded-xl px-4 py-4" aria-live="polite">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2">
            <Icon name={getSemanticIcon("performance.analysis")} size="small" class="text-icon-weak-base" />
            <div class="min-w-0">
              <div class="app-panel-control text-text-strong">{props._(P.analysisTitle)}</div>
              <div class="app-panel-caption text-text-subtle">
                {props._(
                  props.starting
                    ? P.analysisDescriptionPreparing
                    : active()
                      ? {
                          id: "app.performance.analysis.description.running",
                          message: "Diagnosing this snapshot in a model session",
                        }
                      : analysis()?.status === "completed"
                        ? P.analysisDescriptionReady
                        : {
                            id: "app.performance.analysis.description.session",
                            message: "Model diagnosis for the selected snapshot",
                          },
                )}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Show when={analysis()}>
              {(item) => (
                <span class={`app-panel-caption font-medium ${statusTone()}`}>
                  {props._(performanceAnalysisStatusDescriptor(item().status))}
                </span>
              )}
            </Show>
            <Show when={active()}>
              <Button
                type="button"
                variant="secondary"
                size="small"
                icon={getSemanticIcon("action.stop")}
                onClick={props.onCancel}
              >
                {props._(P.analysisCancel)}
              </Button>
            </Show>
            <Show when={analysis()}>
              {(item) => (
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  icon={getSemanticIcon("action.open")}
                  onClick={() => void openSession(item().sessionID)}
                >
                  {props._(P.analysisOpenSession)}
                </Button>
              )}
            </Show>
          </div>
        </div>

        <Show when={props.starting || active()}>
          <p class="mt-3 app-panel-caption text-text-weak">{props._(P.analysisProgress)}</p>
        </Show>
        <Show when={props.error}>
          {(message) => <p class="mt-3 app-panel-caption text-text-on-critical-base">{message()}</p>}
        </Show>
        <Show when={analysis()?.error}>
          {(message) => <p class="mt-3 app-panel-caption text-text-on-critical-base">{message()}</p>}
        </Show>
        <Show when={analysis()?.result}>
          {(result) => (
            <div class="mt-4 border-t border-border-base pt-4">
              <Markdown text={result()} cacheKey={`performance-analysis:${analysis()?.sessionID}`} />
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}

export function TimeRangeControl(props: { value: number; onChange: (value: number) => void }) {
  const { i18n } = useLocale()
  return (
    <AppPanel.Selection
      label={i18n._({ id: "app.performance.timeRange", message: "Time range" })}
      items={TIME_RANGE_MS.map((ms) => ({ id: String(ms), label: i18n._(timeRangeLabel(ms)) }))}
      active={String(props.value)}
      onChange={(value) => props.onChange(Number(value))}
    />
  )
}

function timeRangeLabel(ms: number) {
  if (ms === 15 * 60_000) return P.timeRange15m
  if (ms === 60 * 60_000) return P.timeRange1h
  if (ms === 6 * 60 * 60_000) return P.timeRange6h
  return P.timeRange24h
}

function SummaryQualityNotice(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
}) {
  const msg = () => summaryQualityMessage(props.summary)
  return (
    <Show when={msg()}>
      <div class="performance-card rounded-xl px-4 py-3 app-panel-caption text-text-on-warning-base">
        {props._(msg()!)}
      </div>
    </Show>
  )
}

export function SummaryCards(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
  onIssues?: () => void
}) {
  const { _ } = props
  const summary = () => props.summary
  const cards = () => performanceSummaryCardModel(summary())
  const resources = () => summary()?.resources
  const frontend = () => summary()?.frontend
  const healthLabel = () => {
    const status = summary()?.health.status
    if (status === "healthy") return _(P.summaryHealthy)
    if (status === "degraded") return _(P.summaryDegraded)
    if (status === "critical") return _(P.summaryCritical)
    return _(P.summaryUnknown)
  }
  const serviceMemorySource = () =>
    cards().serviceMemory?.source === "cgroup_v2" ? _(P.summaryMemorySourceCgroup) : _(P.summaryMemorySourceProcess)
  const serviceMemoryCoverage = () =>
    cards().serviceMemory?.completeness === "full" ? _(P.summaryMemoryCoverageFull) : _(P.summaryMemoryCoveragePartial)
  return (
    <>
      <div class="performance-summary-grid">
        <MetricCard
          _={_}
          label={P.summaryHealth}
          value={healthLabel()}
          icon="performance.health"
          onClick={summary()?.health.status !== "healthy" ? props.onIssues : undefined}
        />
        <MetricCard
          _={_}
          label={P.summaryHttpP95}
          value={formatChartDuration(summary()?.backend.p95RequestMs)}
          icon="performance.latency"
        />
        <MetricCard
          _={_}
          label={P.summarySessions}
          value={
            <span class="performance-session-counts">
              <span class="performance-session-count">
                {_({
                  id: "app.performance.sessions.active",
                  message: "{count} active",
                  values: { count: summary()?.backend.activeSessions ?? "—" },
                })}
              </span>
              <span class="performance-session-count">
                {_({
                  id: "app.performance.sessions.pending",
                  message: "{count} pending",
                  values: { count: summary()?.backend.pendingSessions ?? "—" },
                })}
              </span>
            </span>
          }
          icon="performance.trace"
        />
        <MetricCard
          _={_}
          label={P.summaryIssues}
          value={summary() ? String(cards().openIssueCount) : "—"}
          onClick={summary() ? props.onIssues : undefined}
          icon="performance.issue"
          tone={cards().openIssueCount > 0 ? "warning" : "default"}
        />
      </div>
      <section class="performance-section" aria-label={_(P.groupResources)}>
        <h2 class="performance-section-title">{_(P.groupResources)}</h2>
        <div class="performance-resource-grid">
          <div class="performance-resource-group">
            <h3 class="app-panel-section-title">
              {_({ id: "app.performance.resources.cpu", message: "CPU and event loop" })}
            </h3>
            <MetricCard
              _={_}
              label={P.summaryCpu}
              value={formatChartPercent(ratioToPercent(resources()?.cpuUtilizationRatio))}
              icon="performance.cpu"
            />
            <MetricCard
              _={_}
              label={P.summaryEventLoop}
              value={formatChartDuration(resources()?.eventLoopLagP95Ms)}
              icon="performance.latency"
            />
          </div>
          <div class="performance-resource-group">
            <h3 class="app-panel-section-title">{_({ id: "app.performance.resources.memory", message: "Memory" })}</h3>
            <MetricCard
              _={_}
              label={P.summaryServiceMemory}
              value={formatChartBytes(cards().serviceMemory?.rssBytes)}
              hint={
                cards().serviceMemory
                  ? _({
                      id: "app.performance.memory.provenance",
                      message: "{source} · {coverage}",
                      values: { source: serviceMemorySource(), coverage: serviceMemoryCoverage() },
                    })
                  : undefined
              }
              icon="performance.memory"
            />
            <MetricCard
              _={_}
              label={P.summaryServerRss}
              value={formatChartBytes(cards().serverRssBytes)}
              icon="performance.memory"
            />
            <MetricCard
              _={_}
              label={P.summaryHeapUsed}
              value={formatChartBytes(resources()?.heapUsedBytes)}
              icon="performance.memory"
            />
            <MetricCard
              _={_}
              label={P.summaryExternal}
              value={formatChartBytes(resources()?.externalBytes)}
              icon="performance.memory"
            />
            <MetricCard
              _={_}
              label={P.summaryArrayBuffers}
              value={formatChartBytes(resources()?.arrayBuffersBytes)}
              icon="performance.memory"
            />
            <MetricCard
              _={_}
              label={P.summaryToolChildRss}
              value={formatChartBytes(cards().childProcessRssBytes)}
              hint={_({
                id: "app.performance.memory.measured",
                message: "{measured}/{count} processes measured",
                values: { measured: cards().measuredChildProcessCount, count: cards().childProcessCount },
              })}
              icon="performance.memory"
              tone={cards().measuredChildProcessCount < cards().childProcessCount ? "warning" : "default"}
            />
          </div>
          <div class="performance-resource-group">
            <h3 class="app-panel-section-title">{_({ id: "app.performance.resources.disk", message: "Disk" })}</h3>
            <MetricCard
              _={_}
              label={P.summaryDiskIo}
              value={_(P.summaryDiskIoValue.id, {
                read: formatChartBytes(resources()?.appReadBytes),
                write: formatChartBytes(resources()?.appWrittenBytes),
              })}
              icon="performance.disk"
            />
            <MetricCard
              _={_}
              label={P.summaryDiskOps}
              value={
                resources()?.appReadOps !== undefined && resources()?.appWriteOps !== undefined
                  ? _(P.summaryDiskOpsValue.id, {
                      read: String(resources()?.appReadOps),
                      write: String(resources()?.appWriteOps),
                    })
                  : "—"
              }
              icon="performance.disk"
            />
          </div>
          <div class="performance-resource-group">
            <h3 class="app-panel-section-title">
              {_({ id: "app.performance.resources.calls", message: "Model and tool calls" })}
            </h3>
            <MetricCard
              _={_}
              label={P.summaryLlmCalls}
              value={String(summary()?.sessions?.llmCallCount ?? "—")}
              icon="performance.network"
            />
            <MetricCard
              _={_}
              label={P.summaryToolCalls}
              value={String(summary()?.sessions?.toolCallCount ?? "—")}
              icon="performance.trace"
            />
            <MetricCard
              _={_}
              label={P.summaryLongTasks}
              value={String(frontend()?.longTaskCount ?? "—")}
              icon="performance.frontend"
            />
          </div>
        </div>
      </section>
    </>
  )
}

type ResourceOwner = PerformanceSummary["resources"]["owners"][number]

function ResourceOwnership(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
}) {
  const { _ } = props
  const { fmt } = useLocale()
  const owners = () => props.summary?.resources.owners ?? []
  const service = () => props.summary?.resources.serviceMemory
  const ownerLabel = (owner: ResourceOwner["owner"]) => {
    if (owner === "control_plane") return _(P.resourceOwnerControlPlane)
    if (owner === "agent") return _(P.resourceOwnerAgent)
    if (owner === "policy") return _(P.resourceOwnerPolicy)
    if (owner === "plugin") return _(P.resourceOwnerPlugin)
    if (owner === "browser") return _(P.resourceOwnerBrowser)
    if (owner === "mcp") return _(P.resourceOwnerMcp)
    return _(P.resourceOwnerLocalProcess)
  }
  const coverage = (owner: ResourceOwner) =>
    owner.completeness === "unavailable"
      ? _(P.resourceCoverageUnavailable)
      : _(P.resourceCoverageValue.id, {
          measured: String(owner.measuredProcessCount),
          count: String(owner.processCount),
          completeness: owner.completeness === "full" ? _(P.resourceCoverageFull) : _(P.resourceCoveragePartial),
        })
  const recovery = (owner: ResourceOwner) => {
    if (!owner.lastRecovery) return _(P.resourceRecoveryNone)
    return _(P.resourceRecoveryValue.id, {
      action: owner.lastRecovery.action,
      reason: owner.lastRecovery.reason,
      effect:
        owner.lastRecovery.reclaimedBytes === undefined
          ? _(P.resourceRecoveryUnmeasured)
          : _(P.resourceRecoveryReclaimed.id, {
              bytes: formatChartBytes(owner.lastRecovery.reclaimedBytes),
            }),
      time: formatTime(owner.lastRecovery.at, fmt),
    })
  }
  return (
    <section class="performance-card rounded-xl px-4 py-4">
      <div class="mb-3">
        <div class="app-panel-row-title text-text-strong">{_(P.resourceOwnershipTitle)}</div>
        <div class="mt-1 app-panel-caption text-text-weak">{_(P.resourceOwnershipDesc)}</div>
      </div>
      <Show when={service()?.source === "cgroup_v2" ? service() : undefined}>
        {(memory) => (
          <div class="performance-service-memory mb-4 grid gap-2 rounded-lg p-3 app-panel-caption">
            <div>
              <span class="text-text-weak">{_(P.resourceCgroupCurrent)}</span>
              <span class="ml-2 text-text-strong">{formatChartBytes(memory().currentBytes)}</span>
            </div>
            <div>
              <span class="text-text-weak">{_(P.resourceWorkingSet)}</span>
              <span class="ml-2 text-text-strong">{formatChartBytes(memory().workingSetBytes)}</span>
            </div>
            <div>
              <span class="text-text-weak">{_(P.resourceReclaimable)}</span>
              <span class="ml-2 text-text-strong">{formatChartBytes(memory().reclaimableBytes)}</span>
            </div>
          </div>
        )}
      </Show>
      <div class="performance-owner-table-wrap">
        <table class="performance-owner-table w-full text-left app-panel-caption">
          <thead class="text-text-weak">
            <tr>
              <th>{_(P.resourceOwner)}</th>
              <th>{_(P.resourceCurrent)}</th>
              <th>{_(P.resourcePeak)}</th>
              <th>{_(P.resourceBaseline)}</th>
              <th>{_(P.resourceRetained)}</th>
              <th>{_(P.resourceCoverage)}</th>
              <th>{_(P.resourceLastRecovery)}</th>
            </tr>
          </thead>
          <tbody>
            <For each={owners()}>
              {(owner) => (
                <tr>
                  <td>
                    <div class="app-panel-caption font-medium text-text-strong">{ownerLabel(owner.owner)}</div>
                    <div class="mt-0.5 app-panel-caption text-text-weak">{owner.source}</div>
                  </td>
                  <td>{formatChartBytes(owner.currentBytes)}</td>
                  <td>{formatChartBytes(owner.peakBytes)}</td>
                  <td>{formatChartBytes(owner.baselineBytes)}</td>
                  <td>{formatChartBytes(owner.retainedBytes)}</td>
                  <td>{coverage(owner)}</td>
                  <td class="performance-owner-recovery">{recovery(owner)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function MetricCard(props: {
  _: ReturnType<typeof useLingui>["_"]
  label: MessageDescriptor
  value: JSX.Element
  hint?: string
  onClick?: () => void
  icon: Parameters<typeof getSemanticIcon>[0]
  tone?: "default" | "warning"
}) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="flex items-center justify-between gap-3">
        <div class="app-panel-caption font-medium text-text-weak">{props._(props.label)}</div>
        <Icon
          name={getSemanticIcon(props.icon)}
          size="small"
          classList={{
            "text-icon-weak-base": props.tone !== "warning",
            "text-icon-warning-base": props.tone === "warning",
          }}
        />
      </div>
      <div
        class="performance-metric-value mt-2 app-panel-value text-text-strong tabular-nums"
        title={typeof props.value === "string" ? props.value : undefined}
      >
        <Show when={props.onClick} fallback={props.value}>
          <button type="button" class="performance-summary-action" onClick={props.onClick}>
            {props.value}
            <span class="sr-only">
              {props._({ id: "app.performance.openDiagnostics", message: "Open diagnostics" })}
            </span>
          </button>
        </Show>
      </div>
      <Show when={props.hint || props.value === "—"}>
        <p class="app-panel-caption text-text-weak mt-1">
          {props.hint ??
            props._({ id: "app.performance.metric.unavailable", message: "No measurement in this snapshot" })}
        </p>
      </Show>
    </div>
  )
}

function RuntimeSupport(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
}) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.health")} size="small" class="text-icon-weak-base" />
        <div>
          <h3 class="app-panel-row-title text-text-strong">{props._(P.runtimeHealth)}</h3>
          <p class="mt-1 app-panel-caption text-text-weak">{props._(P.runtimeHealthDesc)}</p>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <For each={runtimeSupportItems(props.summary, { _: props._ } as I18n)}>
          {(item) => (
            <div class="performance-card-soft rounded-lg px-3 py-2">
              <div class="app-panel-caption font-medium uppercase tracking-[0.1em] text-text-weaker">
                {props._(item.label)}
              </div>
              <div
                classList={{
                  "mt-1 app-panel-control text-text-strong tabular-nums": true,
                  "text-text-on-warning-base": item.tone === "warning",
                  "text-text-on-success-base": item.tone === "success",
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
  _: ReturnType<typeof useLingui>["_"]
  title: MessageDescriptor
  description: MessageDescriptor
  points: PerformanceMetricPoint[]
  datasets: ChartDatasetSpec[]
  quality?: MessageDescriptor
  emptyLabel?: MessageDescriptor
}) {
  const chartTheme = useChartTheme()
  const { fmt } = useLocale()
  const model = createMemo(() => {
    return buildLineChartModel({
      points: props.points,
      datasets: props.datasets,
      theme: chartTheme(),
      formatTime: (value) => fmt.time(new Date(value), { hour: "2-digit", minute: "2-digit" }),
    })
  })

  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3">
        <h3 class="app-panel-row-title text-text-strong">{props._(props.title)}</h3>
        <p class="mt-1 app-panel-caption text-text-weak">{props._(props.description)}</p>
        <Show when={props.quality}>
          {(quality) => <p class="mt-1 app-panel-caption text-text-on-warning-base">{props._(quality())}</p>}
        </Show>
      </div>
      <Show
        when={hasVisibleChartData(props.points, props.datasets)}
        fallback={<EmptyState _={props._} label={props.emptyLabel ?? P.chartNoSamples} />}
      >
        <div class="h-56">
          <Line data={model().data} options={model().options} />
        </div>
      </Show>
    </div>
  )
}

function Timeline(props: {
  _: ReturnType<typeof useLingui>["_"]
  traces: PerformanceTraceSpan[]
  labels: ReadonlyMap<string, string>
  onSelect: (trace: PerformanceTraceSpan) => void
}) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.timeline")} size="small" class="text-icon-weak-base" />
        <h3 class="app-panel-row-title text-text-strong">{props._(P.timelineTitle)}</h3>
      </div>
      <Show when={props.traces.length > 0} fallback={<EmptyState _={props._} label={P.timelineNoSpans} />}>
        <div class="flex flex-col gap-2">
          <For each={props.traces}>
            {(trace) => (
              <button
                type="button"
                class="performance-card-soft flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover-base"
                onClick={() => props.onSelect(trace)}
              >
                <div class="h-2 w-2 shrink-0 rounded-full bg-icon-interactive-base" />
                <div class="min-w-0 flex-1">
                  <div class="line-clamp-2 app-panel-row-title text-text-strong">
                    {props.labels.get(trace.traceId) ?? trace.name}
                  </div>
                  <Show
                    when={!props.labels.has(trace.traceId) && (trace.kind === "http" || trace.name === "http.request")}
                  >
                    <p class="app-panel-caption text-text-weak">
                      {props._({ id: "app.performance.trace.limited", message: "Information limited" })}
                    </p>
                  </Show>
                  <div class="truncate app-panel-caption text-text-weaker">
                    {[trace.kind, trace.module, traceStatusLabel(trace.status)]
                      .filter(Boolean)
                      .map((value) => (typeof value === "string" ? value : props._(value)))
                      .join(" · ")}
                  </div>
                </div>
                <div class="app-panel-caption font-medium text-text-weak tabular-nums">
                  {formatChartDuration(trace.durationMs)}
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
export function IssueList(props: {
  _: ReturnType<typeof useLingui>["_"]
  fmt: ReturnType<typeof useLocale>["fmt"]
  issues: PerformanceIssue[]
  onTrace: (issue: PerformanceIssue) => void
}) {
  return (
    <section class="performance-card rounded-xl p-4">
      <h3 class="app-panel-section-title text-text-strong mb-3">{props._(P.issuesTitle)}</h3>
      <Show when={props.issues.length} fallback={<EmptyState _={props._} label={P.issuesNoActive} />}>
        <div class="flex flex-col gap-3">
          <For each={props.issues}>
            {(issue) => {
              const title = () => issueTitle(issue)
              return (
                <article class="performance-issue-row">
                  <div class="flex items-start justify-between gap-3">
                    <h4 class="app-panel-row-title text-text-strong line-clamp-2">
                      {typeof title() === "string" ? (title() as string) : props._(title() as MessageDescriptor)}
                    </h4>
                    <span class={severityClass(issue.severity)}>{props._(ISSUE_SEVERITY[issue.severity])}</span>
                  </div>
                  <p class="app-panel-caption text-text-weak mt-1">
                    {props._({
                      id: "app.performance.issue.occurrences",
                      message: "{count} occurrences · last seen {time}",
                      values: { count: issue.occurrenceCount, time: formatTime(issue.lastSeenTime, props.fmt) },
                    })}
                  </p>
                  <Show when={typeof issue.evidence?.observedValue === "number"}>
                    <p class="app-panel-caption text-text-base mt-1">
                      {props._({
                        id: "app.performance.issue.observed",
                        message: "Observed: {value}",
                        values: {
                          value: formatChartMetricValue(
                            issue.evidence?.observedValue as number,
                            typeof issue.evidence?.unit === "string" ? issue.evidence?.unit : "",
                          ),
                        },
                      })}
                    </p>
                  </Show>
                  <Show when={issue.traceId}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      class="performance-issue-trace"
                      onClick={() => props.onTrace(issue)}
                    >
                      {props._({ id: "app.performance.issue.inspectTrace", message: "Inspect related trace" })}
                    </Button>
                  </Show>
                  <details class="performance-issue-details mt-1">
                    <summary class="app-panel-caption text-text-weak">{props._(P.errorDetails)}</summary>
                    <div class="app-panel-copy text-text-base flex flex-col gap-2 mt-2 break-words">
                      <p>{issue.message}</p>
                      <Show when={issue.recommendation}>
                        <p>{issue.recommendation}</p>
                      </Show>
                      <p class="app-panel-caption text-text-weak">
                        {issue.module} · {issue.code}
                      </p>
                    </div>
                  </details>
                </article>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

function ToolFailures(props: { _: ReturnType<typeof useLingui>["_"]; items: ToolFailureItem[] }) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.tools")} size="small" class="text-icon-weak-base" />
        <div>
          <h3 class="app-panel-row-title text-text-strong">{props._(P.toolFailures)}</h3>
          <p class="mt-1 app-panel-caption text-text-weak">{props._(P.toolFailuresDesc)}</p>
        </div>
      </div>
      <Show when={props.items.length > 0} fallback={<EmptyState _={props._} label={P.toolFailuresEmpty} />}>
        <div class="flex flex-col gap-1.5">
          <For each={props.items}>
            {(item) => {
              const cats = toolFailureCategories(item)
              return (
                <div class="performance-card-soft flex items-start gap-3 rounded-lg px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <div class="truncate app-panel-caption font-medium text-text-strong">{item.tool}</div>
                    <div class="mt-0.5 truncate app-panel-caption text-text-weaker">
                      {typeof cats === "string" ? cats : props._(cats)}
                    </div>
                  </div>
                  <div class="shrink-0 text-right tabular-nums">
                    <div class="app-panel-caption font-medium text-text-weak">
                      {item.errorCount} {props._(P.toolFailuresFailed)} · {formatChartPercent(item.errorRate * 100)}
                    </div>
                    <div class="mt-0.5 app-panel-caption text-text-weaker">
                      {item.callCount} {props._(P.toolFailuresCalls)}
                    </div>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

export function TopRankings(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
  labels?: ReadonlyMap<string, string>
  onTrace: (item: RankedItem) => void
}) {
  const groups = createMemo(() => {
    const top = props.summary?.top
    return [
      { title: P.rankingSlowRoutes, icon: "performance.routes" as const, items: top?.slowRoutes ?? [] },
      { title: P.rankingSlowSessions, icon: "performance.sessions" as const, items: top?.slowSessions ?? [] },
      { title: P.rankingSlowTools, icon: "performance.tools" as const, items: top?.slowTools ?? [] },
      { title: P.rankingSlowProviders, icon: "performance.providers" as const, items: top?.slowProviders ?? [] },
      { title: P.rankingSlowStorage, icon: "performance.storage" as const, items: top?.slowStorage ?? [] },
      { title: P.rankingSlowLibrary, icon: "performance.library" as const, items: top?.slowLibrary ?? [] },
      { title: P.rankingChildProcess, icon: "performance.memory" as const, items: top?.childProcesses ?? [] },
    ]
  })
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.routes")} size="small" class="text-icon-weak-base" />
        <h3 class="app-panel-row-title text-text-strong">{props._(P.topRankings)}</h3>
      </div>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <For each={groups()}>
          {(group) => (
            <div>
              <div class="mb-2 app-panel-caption font-medium uppercase tracking-[0.12em] text-text-weaker">
                {props._(group.title)}
              </div>
              <Show when={group.items.length > 0} fallback={<EmptyState _={props._} label={P.rankingEmpty} />}>
                <div class="flex flex-col gap-1.5">
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        class="performance-card-soft flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover-base"
                        onClick={() => props.onTrace(item)}
                      >
                        <div class="min-w-0 flex-1">
                          <div class="line-clamp-2 app-panel-row-title text-text-strong">
                            {(item.traceId && props.labels?.get(item.traceId)) || item.label}
                          </div>
                          <Show
                            when={
                              item.label.startsWith("http.request") &&
                              !(item.traceId && props.labels?.has(item.traceId))
                            }
                          >
                            <p class="app-panel-caption text-text-weak">
                              {props._({ id: "app.performance.trace.limited", message: "Information limited" })}
                            </p>
                          </Show>
                          <div class="truncate app-panel-caption text-text-weaker">
                            {[item.module, item.sessionID, item.tool].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <div class="app-panel-caption font-medium text-text-weak tabular-nums">
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
    </div>
  )
}

function BrowserMetricsChart(props: { _: ReturnType<typeof useLingui>["_"]; samples: BrowserMetricSample[] }) {
  const chartTheme = useChartTheme()
  const colors = createMemo(() => {
    const colors = chartTheme()
    return {
      browser: colors.series[4],
      memory: colors.series[2],
      request: colors.series[3],
    }
  })
  const points = createMemo(() => browserMetricPoints(props.samples))
  const memoryUnsupported = createMemo(
    () => props.samples.length > 0 && props.samples.every((sample) => sample.memory === undefined),
  )
  return (
    <PerformanceLineChart
      _={props._}
      title={P.chartBrowser}
      description={P.chartBrowserDesc}
      points={points()}
      datasets={[
        megabytesDataset(
          props._(P.datasetHeapUsed),
          "memory",
          colors().browser,
          props._({ id: "app.performance.source.localHeap", message: "Local browser memory sample" }),
        ),
        countDataset(
          props._({ id: "app.performance.dataset.domNodes", message: "DOM nodes" }),
          "domNodes",
          colors().memory,
          props._({ id: "app.performance.source.localDom", message: "Local DOM sample" }),
          props._(P.axisCount),
        ),
        durationDataset(
          props._({ id: "app.performance.dataset.navigation", message: "Navigation duration" }),
          "latency",
          colors().request,
          props._({ id: "app.performance.source.localNavigation", message: "Local navigation timing sample" }),
        ),
      ]}
      quality={memoryUnsupported() ? P.chartBrowserMemoryUnsupported : undefined}
    />
  )
}

export function FrontendSection(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
  stale?: boolean
}) {
  const frontend = () => props.summary?.frontend
  const metricState = (value: number | undefined, entryType: string) => {
    const missing = browserMetricState(value, entryType, props._)
    if (missing) return missing
    if (props.stale) return props._({ id: "app.performance.browser.stale", message: "From the previous snapshot" })
    if (props.summary?.quality?.partial || props.summary?.quality?.truncated)
      return props._({ id: "app.performance.browser.partial", message: "Partial snapshot" })
    if (props.summary?.quality?.retentionLimited)
      return props._({ id: "app.performance.browser.retention", message: "Retention-limited snapshot" })
    return undefined
  }
  const slow = () => props.summary?.top.slowFrontend ?? []
  return (
    <div class="performance-frontend-grid">
      <div class="performance-card rounded-xl p-4">
        <div class="mb-3 flex items-center gap-2">
          <Icon name={getSemanticIcon("performance.frontend")} size="small" class="text-icon-weak-base" />
          <h3 class="app-panel-row-title text-text-strong">{props._(P.frontendSlow)}</h3>
        </div>
        <Show when={slow().length > 0} fallback={<EmptyState _={props._} label={P.frontendNoSlow} />}>
          <div class="flex flex-col gap-1.5">
            <For each={slow()}>
              {(item) => (
                <div class="performance-card-soft flex items-center gap-3 rounded-lg px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <div class="truncate app-panel-caption font-medium text-text-strong">{item.label}</div>
                    <div class="truncate app-panel-caption text-text-weaker">{item.module}</div>
                  </div>
                  <div class="app-panel-caption font-medium text-text-weak tabular-nums">
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
          <Icon name={getSemanticIcon("performance.vitals")} size="small" class="text-icon-weak-base" />
          <h3 class="app-panel-row-title text-text-strong">{props._(P.frontendVitals)}</h3>
        </div>
        <div class="grid grid-cols-2 gap-2 app-panel-caption">
          <Vital
            label="INP"
            value={formatChartDuration(frontend()?.inpMs)}
            state={metricState(frontend()?.inpMs, "event")}
          />
          <Vital
            label="LCP"
            value={formatChartDuration(frontend()?.lcpMs)}
            state={metricState(frontend()?.lcpMs, "largest-contentful-paint")}
          />
          <Vital
            label="CLS"
            value={formatDecimal(frontend()?.cls)}
            state={metricState(frontend()?.cls, "layout-shift")}
          />
          <Vital
            label="FCP"
            value={formatChartDuration(frontend()?.fcpMs)}
            state={metricState(frontend()?.fcpMs, "paint")}
          />
          <Vital
            label="TTFB"
            value={formatChartDuration(frontend()?.ttfbMs)}
            state={metricState(frontend()?.ttfbMs, "navigation")}
          />
          <Vital
            label={props._(P.frontendResourceP95)}
            value={formatChartDuration(frontend()?.resourceP95Ms)}
            state={metricState(frontend()?.resourceP95Ms, "resource")}
          />
          <Vital
            label={props._(P.summaryLongTasks)}
            value={String(frontend()?.longTaskCount ?? "—")}
            state={metricState(frontend()?.longTaskCount, "longtask")}
          />
        </div>
      </div>
    </div>
  )
}

function Vital(props: { label: string; value: string; state?: string }) {
  return (
    <div class="performance-card-soft rounded-lg px-3 py-2">
      <div class="app-panel-caption font-medium uppercase tracking-[0.1em] text-text-weaker">{props.label}</div>
      <div class="mt-1 app-panel-control text-text-strong tabular-nums">{props.value}</div>
      <Show when={props.state}>
        <p class="app-panel-caption text-text-weak mt-1">{props.state}</p>
      </Show>
    </div>
  )
}

function traceStatusLabel(status?: string) {
  const labels: Record<string, MessageDescriptor> = {
    ok: { id: "app.performance.trace.status.ok", message: "Completed" },
    running: { id: "app.performance.trace.status.running", message: "Running" },
    error: { id: "app.performance.trace.status.error", message: "Failed" },
    cancelled: { id: "app.performance.trace.status.cancelled", message: "Cancelled" },
    timeout: { id: "app.performance.trace.status.timeout", message: "Timed out" },
    interrupted: { id: "app.performance.trace.status.interrupted", message: "Interrupted" },
  }
  return (status ? labels[status] : undefined) ?? P.traceUnknown
}

export function TraceDialog(props: {
  _: ReturnType<typeof useLingui>["_"]
  fmt: ReturnType<typeof useLocale>["fmt"]
  trace: PerformanceTracePreview | null
  detail: PerformanceTraceDetail | null
  loading: boolean
  error?: string
  onRetry: () => void
}) {
  return (
    <Dialog
      size="wide"
      class="app-panel-detail-dialog performance-trace-dialog"
      title={props.trace?.name ?? props._(P.traceDetail)}
    >
      <p class="app-panel-caption text-text-weak mb-4">{props.trace?.traceId}</p>
      <Show when={props.loading}>
        <p role="status" class="app-panel-caption">
          {props._({ id: "app.performance.trace.loading", message: "Loading trace details…" })}
        </p>
      </Show>
      <Show when={props.error}>
        <div role="alert" class="performance-trace-error">
          <p class="app-panel-caption">{props.error}</p>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
              const trigger = event.currentTarget
              const surface = trigger.closest<HTMLElement>('[role="dialog"]')
              props.onRetry()
              queueMicrotask(() => {
                if (!trigger.isConnected && document.activeElement === document.body) surface?.focus()
              })
            }}
          >
            {props._(P.retry)}
          </Button>
        </div>
      </Show>
      <Show when={props.trace}>
        {(trace) => (
          <div class="flex flex-col gap-3 app-panel-caption">
            <DetailRow
              _={props._}
              label={P.traceStatus}
              value={trace().status ? props._(traceStatusLabel(trace().status!)) : props._(P.traceUnknown)}
            />
            <DetailRow _={props._} label={P.traceDuration} value={formatChartDuration(trace().durationMs)} />
            <DetailRow _={props._} label={P.traceModule} value={trace().module ?? "—"} />
            <DetailRow _={props._} label={P.traceSession} value={trace().sessionID ?? "—"} />
            <DetailRow _={props._} label={P.traceStart} value={formatTime(trace().startedAt, props.fmt)} />
            <DetailRow _={props._} label={P.traceEnd} value={formatTime(trace().endedAt, props.fmt)} />
            <Show when={trace().errorCode}>
              <div class="performance-card-soft rounded-lg p-3 text-text-on-warning-base">{trace().errorCode}</div>
            </Show>
            <Show when={props.detail?.spans.length}>
              <div>
                <div class="mb-2 app-panel-caption font-medium uppercase tracking-[0.12em] text-text-weaker">
                  {props._(P.traceSpans)}
                </div>
                <div class="flex flex-col gap-1.5">
                  <For each={props.detail?.spans ?? []}>
                    {(span) => (
                      <div class="performance-card-soft rounded-lg px-3 py-2">
                        <div class="truncate app-panel-caption font-medium text-text-strong">
                          {traceDisplayName(span.name, span.attributes)}
                        </div>
                        <div class="mt-1 app-panel-caption text-text-weaker">
                          {[span.module, props._(traceStatusLabel(span.status)), formatChartDuration(span.durationMs)]
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
                <div class="mb-2 app-panel-caption font-medium uppercase tracking-[0.12em] text-text-weaker">
                  {props._(P.traceEvents)}
                </div>
                <div class="flex flex-col gap-1.5">
                  <For each={(props.detail?.events ?? []).slice(0, 20)}>
                    {(event) => (
                      <div class="performance-card-soft rounded-lg px-3 py-2">
                        <div class="truncate app-panel-caption font-medium text-text-strong">{event.type}</div>
                        <div class="mt-1 app-panel-caption text-text-weaker">
                          {formatTime(event.iso ?? event.time, props.fmt)}
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
    </Dialog>
  )
}

function DetailRow(props: { _: ReturnType<typeof useLingui>["_"]; label: MessageDescriptor; value: string }) {
  return (
    <div class="flex items-center justify-between gap-3 border-b border-border-weaker-base/70 pb-2">
      <span class="text-text-weaker">{props._(props.label)}</span>
      <span class="break-words text-right text-text-base">{props.value}</span>
    </div>
  )
}

function EmptyState(props: { _: ReturnType<typeof useLingui>["_"]; label: MessageDescriptor }) {
  return (
    <div class="performance-card-soft rounded-lg px-3 py-8 text-center app-panel-caption text-text-weaker">
      {props._(props.label)}
    </div>
  )
}

function percentDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: HexColor,
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
    axisTitle: "%",
    formatter: formatChartPercent,
  }
}

function durationDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: HexColor,
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
    axisTitle: "ms",
    formatter: formatChartDuration,
  }
}

function megabytesDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: HexColor,
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
    axisTitle: "MiB",
    formatter: (value) => `${value.toFixed(value >= 10 ? 0 : 1)} MiB`,
  }
}

function countDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: HexColor,
  source: string,
  axisTitle: string,
): ChartDatasetSpec {
  return {
    label,
    field,
    color,
    source,
    unit: "count",
    stat: label.includes("bucket") ? "count" : "latest",
    axisId: "count",
    axisTitle,
    formatter: (value) => value.toFixed(value >= 10 ? 0 : 1),
  }
}

function bytesDataset(
  label: string,
  field: keyof PerformanceMetricPoint,
  color: HexColor,
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
    axisTitle: "B",
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

function timelineQuality(
  timeline: PerformanceTimeline | null | undefined,
  metrics: string[],
): MessageDescriptor | undefined {
  if (!timeline) return undefined
  if (timeline.quality?.truncated || timeline.quality?.partial) return P.qualityPartial
  const related = timeline.series.filter((series) => metrics.includes(series.name))
  if (!related.length) return P.qualityUnavailable
  if (related.every((series) => (series.sampleCount ?? 0) === 0)) return P.qualityUnavailable
  if (related.some((series) => series.quality?.retentionLimited)) return P.qualityRetention
  return undefined
}

function formatDecimal(value?: number): string {
  if (value === undefined) return "—"
  return value.toFixed(value >= 1 ? 2 : 3)
}

function formatTime(
  value: number | string | undefined,
  fmt: { dateTime: (v: Date | number, o?: Intl.DateTimeFormatOptions) => string },
): string {
  if (value === undefined) return ""
  const time = typeof value === "number" ? value : Date.parse(value)
  if (Number.isNaN(time)) return String(value)
  return fmt.dateTime(new Date(time))
}

function issueTraceFallback(issue: PerformanceIssue): Partial<PerformanceTraceSpan> {
  return {
    name: issue.title ?? issue.message ?? P.issuesFallbackName.message,

    module: issue.module,
    sessionID: issue.sessionID,
    redactionApplied: true,
  }
}

function rankedTraceFallback(item: RankedItem): Partial<PerformanceTraceSpan> {
  return {
    name: item.label,
    status:
      item.status === "error" || item.status === "cancelled" || item.status === "timeout" ? item.status : undefined,
    module: item.module,
    sessionID: item.sessionID,
    redactionApplied: true,
  }
}

function severityClass(severity?: string): string {
  const base = "shrink-0 rounded-md px-2 py-0.5 app-panel-caption"
  if (severity === "critical" || severity === "error")
    return `${base} bg-surface-critical-weak text-text-on-critical-base`
  if (severity === "warning") return `${base} bg-surface-warning-weak text-text-on-warning-base`
  return `${base} bg-surface-base text-text-weaker`
}

function browserMetricState(value: number | undefined, entryType: string, _: ReturnType<typeof useLingui>["_"]) {
  if (value !== undefined) return undefined
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes(entryType))
    return _({
      id: "app.performance.browser.unsupported",
      message: "Unsupported by this browser; no snapshot measurement",
    })
  return _({ id: "app.performance.browser.noSamples", message: "No samples in this snapshot" })
}
