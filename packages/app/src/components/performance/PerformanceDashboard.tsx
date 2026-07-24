import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Line } from "solid-chartjs"
import { Chart as ChartJS, CategoryScale, Filler, LinearScale, LineElement, PointElement, Tooltip } from "chart.js"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
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
import { performanceSummaryCardModel } from "./summary-card-model"
import { usePerformance } from "./use-performance"
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
} from "./types"

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const TIME_RANGE_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]

type RankedItem = PerformanceSummary["top"]["slowRoutes"][number]

export function PerformanceDashboard() {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const perf = usePerformance()
  const chartTheme = useChartTheme()
  const chartColors = createMemo(() => {
    const colors = chartTheme()
    return {
      cpu: colors.color("text-interactive-base"),
      memory: colors.color("text-on-success-base"),
      request: colors.color("text-on-warning-base"),
      browser: colors.color("syntax-type"),
      disk: colors.color("text-on-critical-base"),
    }
  })
  const [selectedTrace, setSelectedTrace] = createSignal<PerformanceTraceSpan | null>(null)
  const [selectedTraceDetail, setSelectedTraceDetail] = createSignal<PerformanceTraceDetail | null>(null)
  const summary = () => perf.summary()
  const issues = createMemo(() => (summary()?.issues ?? []).slice(0, 12))
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
        <div class="text-12-medium text-text-weak">
          {summary()?.generatedAt
            ? _(P.snapshotFrom.id, { time: formatTime(summary()?.generatedAt, fmt) })
            : _(P.snapshotLabel)}
        </div>
        <div class="flex items-center gap-2">
          <TimeRangeControl value={perf.windowMs()} onChange={(value) => perf.setWindowMs(value)} />
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("performance.analysis")}
            disabled={perf.analysisStarting() || isPerformanceAnalysisActive(perf.analysis()?.status)}
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
            {_(P.refresh)}
          </Button>
        </div>
      </div>

      <Show when={perf.error()}>
        <div class="performance-card rounded-xl px-4 py-3 text-12-regular text-icon-warning-base">{perf.error()}</div>
      </Show>

      <SummaryQualityNotice _={_} summary={summary()} />
      <PerformanceAnalysisCard
        _={_}
        analysis={perf.analysis()}
        error={perf.analysisError()}
        starting={perf.analysisStarting()}
        onCancel={() => void perf.cancelAnalysis()}
      />
      <SummaryCards _={_} summary={summary()} />
      <ResourceOwnership _={_} summary={summary()} />
      <RuntimeSupport _={_} summary={summary()} />

      <div class="performance-chart-grid">
        <PerformanceLineChart
          _={_}
          title={P.chartCpu}
          description={P.chartCpuDesc}
          points={resourcePressurePoints(perf.timeline())}
          datasets={[
            percentDataset("CPU", "cpu", chartColors().cpu, "Timeline process.cpu.utilization"),
            durationDataset(
              "Event loop",
              "eventLoopLag",
              chartColors().request,
              "Timeline process.event_loop.lag",
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
            megabytesDataset(_(P.datasetRss), "memory", chartColors().memory, "Timeline process.memory.rss"),
            megabytesDataset(
              _(P.datasetHeapUsed),
              "heapUsed",
              chartColors().browser,
              "Timeline process.memory.heap_used",
            ),
            megabytesDataset(
              _(P.datasetHeapTotal),
              "heapTotal",
              chartColors().disk,
              "Timeline process.memory.heap_total",
            ),
            megabytesDataset(
              _(P.datasetExternal),
              "external",
              chartColors().request,
              "Timeline process.memory.external",
            ),
            megabytesDataset(
              _(P.datasetArrayBuffers),
              "arrayBuffers",
              chartColors().cpu,
              "Timeline process.memory.array_buffers",
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
        <PerformanceLineChart
          _={_}
          title={P.chartRequests}
          description={P.chartRequestsDesc}
          points={requestTimelinePoints(perf.timeline())}
          datasets={[
            durationDataset("Request", "latency", chartColors().cpu, "Timeline http.request.duration", "p95"),
            countDataset(
              "Requests / bucket",
              "requests",
              chartColors().request,
              "Bucket sample count for http.request.duration",
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
            countDataset("Active turns", "activeSessions", chartColors().memory, "Timeline session.turn.active"),
            durationDataset("Turn", "latency", chartColors().browser, "Timeline session.turn.duration", "p95"),
          ]}
          quality={timelineQuality(perf.timeline(), ["session.turn.active", "session.turn.duration"])}
          emptyLabel={P.chartSessionsEmpty}
        />
        <PerformanceLineChart
          _={_}
          title={P.chartStorage}
          description={P.chartStorageDesc}
          points={storagePoints(perf.timeline())}
          datasets={[
            countDataset("Operations / bucket", "diskOps", chartColors().disk, "Timeline storage.operation.count"),
            durationDataset(
              "Operation",
              "latency",
              chartColors().request,
              "Timeline storage.operation.duration",
              "p95",
            ),
            bytesDataset("Read bytes / bucket", "readBytes", chartColors().memory, "Timeline storage.read.bytes"),
            bytesDataset("Write bytes / bucket", "writeBytes", chartColors().browser, "Timeline storage.write.bytes"),
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

      <div class="performance-split-grid">
        <Timeline _={_} traces={traces()} onSelect={(trace) => void selectTrace(trace.traceId, trace)} />
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
        onTrace={(item) => item.traceId && void selectTrace(item.traceId, rankedTraceFallback(item))}
      />
      <BrowserMetricsChart _={_} samples={perf.browserSamples()} />
      <FrontendSection _={_} summary={summary()} />
      <TraceDrawer
        _={_}
        fmt={fmt}
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
              <div class="text-13-medium text-text-strong">{props._(P.analysisTitle)}</div>
              <div class="text-11-regular text-text-subtle">
                {props._(analysis() ? P.analysisDescriptionReady : P.analysisDescriptionPreparing)}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Show when={analysis()}>
              {(item) => (
                <span class={`text-12-medium ${statusTone()}`}>
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
          <p class="mt-3 text-12-regular text-text-weak">{props._(P.analysisProgress)}</p>
        </Show>
        <Show when={props.error}>
          {(message) => <p class="mt-3 text-12-regular text-text-on-critical-base">{message()}</p>}
        </Show>
        <Show when={analysis()?.error}>
          {(message) => <p class="mt-3 text-12-regular text-text-on-critical-base">{message()}</p>}
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

function TimeRangeControl(props: { value: number; onChange: (value: number) => void }) {
  const { i18n } = useLocale()
  return (
    <div class="performance-control flex items-center rounded-lg p-1">
      <For each={TIME_RANGE_MS}>
        {(ms) => (
          <button
            type="button"
            classList={{
              "rounded-md px-2.5 py-1 text-11-medium transition-colors": true,
              "workbench-selected-surface text-text-strong shadow-sm": props.value === ms,
              "text-text-weak hover:text-text-base": props.value !== ms,
            }}
            onClick={() => props.onChange(ms)}
          >
            {i18n._(timeRangeLabel(ms))}
          </button>
        )}
      </For>
    </div>
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
      <div class="performance-card rounded-xl px-4 py-3 text-12-regular text-icon-warning-base">{props._(msg()!)}</div>
    </Show>
  )
}

function SummaryCards(props: { _: ReturnType<typeof useLingui>["_"]; summary: PerformanceSummary | null | undefined }) {
  const { _ } = props
  const summary = () => props.summary
  const cards = () => performanceSummaryCardModel(summary())
  const resources = () => summary()?.resources
  const frontend = () => summary()?.frontend
  const serviceMemorySource = () =>
    cards().serviceMemory?.source === "cgroup_v2" ? _(P.summaryMemorySourceCgroup) : _(P.summaryMemorySourceProcess)
  const serviceMemoryCoverage = () =>
    cards().serviceMemory?.completeness === "full" ? _(P.summaryMemoryCoverageFull) : _(P.summaryMemoryCoveragePartial)
  return (
    <div class="performance-summary-grid">
      <MetricCard
        _={_}
        label={P.summaryHealth}
        value={summary()?.health.status ?? _(P.summaryUnknown)}
        icon="performance.health"
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
        value={_(P.summarySessionsValue.id, {
          active: String(summary()?.backend.activeSessions ?? 0),
          pending: String(summary()?.backend.pendingSessions ?? 0),
        })}
        icon="performance.trace"
      />
      <MetricCard
        _={_}
        label={P.summaryIssues}
        value={String(cards().openIssueCount)}
        icon="performance.issue"
        tone={cards().openIssueCount > 0 ? "warning" : "default"}
      />
      <MetricCard
        _={_}
        label={P.summaryCpu}
        value={formatChartPercent(ratioToPercent(resources()?.cpuUtilizationRatio))}
        icon="performance.cpu"
      />
      <MetricCard
        _={_}
        label={P.summaryServiceMemory}
        value={
          cards().serviceMemory
            ? _(P.summaryServiceMemoryValue.id, {
                rss: formatChartBytes(cards().serviceMemory?.rssBytes),
                source: serviceMemorySource(),
                coverage: serviceMemoryCoverage(),
              })
            : "—"
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
        value={_(P.summaryToolChildRssValue.id, {
          rss: formatChartBytes(cards().childProcessRssBytes),
          measured: String(cards().measuredChildProcessCount),
          count: String(cards().childProcessCount),
        })}
        icon="performance.memory"
        tone={cards().measuredChildProcessCount < cards().childProcessCount ? "warning" : "default"}
      />
      <MetricCard
        _={_}
        label={P.summaryEventLoop}
        value={formatChartDuration(resources()?.eventLoopLagP95Ms)}
        icon="performance.latency"
      />
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
        value={_(P.summaryDiskOpsValue.id, {
          read: String(resources()?.appReadOps ?? 0),
          write: String(resources()?.appWriteOps ?? 0),
        })}
        icon="performance.disk"
      />
      <MetricCard
        _={_}
        label={P.summaryLlmCalls}
        value={String(summary()?.sessions?.llmCallCount ?? 0)}
        icon="performance.network"
      />
      <MetricCard
        _={_}
        label={P.summaryToolCalls}
        value={String(summary()?.sessions?.toolCallCount ?? 0)}
        icon="performance.trace"
      />
      <MetricCard
        _={_}
        label={P.summaryLongTasks}
        value={String(frontend()?.longTaskCount ?? 0)}
        icon="performance.frontend"
      />
    </div>
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
        <div class="text-14-medium text-text-strong">{_(P.resourceOwnershipTitle)}</div>
        <div class="mt-1 text-12-regular text-text-weak">{_(P.resourceOwnershipDesc)}</div>
      </div>
      <Show when={service()?.source === "cgroup_v2" ? service() : undefined}>
        {(memory) => (
          <div class="performance-service-memory mb-4 grid gap-2 rounded-lg p-3 text-12-regular">
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
        <table class="performance-owner-table w-full text-left text-12-regular">
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
                    <div class="text-12-medium text-text-strong">{ownerLabel(owner.owner)}</div>
                    <div class="mt-0.5 text-11-regular text-text-weak">{owner.source}</div>
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
  value: string
  icon: Parameters<typeof getSemanticIcon>[0]
  tone?: "default" | "warning"
}) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="flex items-center justify-between gap-3">
        <div class="text-11-medium uppercase tracking-[0.12em] text-text-weaker">{props._(props.label)}</div>
        <Icon
          name={getSemanticIcon(props.icon)}
          size="small"
          classList={{
            "text-icon-weak-base": props.tone !== "warning",
            "text-icon-warning-base": props.tone === "warning",
          }}
        />
      </div>
      <div class="mt-2 truncate text-20-semibold text-text-strong tabular-nums">{props.value}</div>
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
          <h3 class="text-14-semibold text-text-strong">{props._(P.runtimeHealth)}</h3>
          <p class="mt-1 text-11-regular text-text-weak">{props._(P.runtimeHealthDesc)}</p>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <For each={runtimeSupportItems(props.summary, { _: props._ } as I18n)}>
          {(item) => (
            <div class="performance-card-soft rounded-lg px-3 py-2">
              <div class="text-10-medium uppercase tracking-[0.1em] text-text-weaker">{props._(item.label)}</div>
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
        <h3 class="text-14-semibold text-text-strong">{props._(props.title)}</h3>
        <p class="mt-1 text-11-regular text-text-weak">{props._(props.description)}</p>
        <Show when={props.quality}>
          {(quality) => <p class="mt-1 text-11-regular text-icon-warning-base">{props._(quality())}</p>}
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
  onSelect: (trace: PerformanceTraceSpan) => void
}) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.timeline")} size="small" class="text-icon-weak-base" />
        <h3 class="text-14-semibold text-text-strong">{props._(P.timelineTitle)}</h3>
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
function IssueList(props: {
  _: ReturnType<typeof useLingui>["_"]
  fmt: ReturnType<typeof useLocale>["fmt"]
  issues: PerformanceIssue[]
  onTrace: (issue: PerformanceIssue) => void
}) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.issue")} size="small" class="text-icon-weak-base" />
        <h3 class="text-14-semibold text-text-strong">{props._(P.issuesTitle)}</h3>
      </div>
      <Show when={props.issues.length > 0} fallback={<EmptyState _={props._} label={P.issuesNoActive} />}>
        <div class="flex flex-col gap-2">
          <For each={props.issues}>
            {(issue) => {
              const content = (
                <>
                  <div class="flex items-center justify-between gap-3">
                    <div class="truncate text-12-medium text-text-strong">
                      {issue.title ?? issue.message ?? props._(P.issuesFallbackName)}
                    </div>
                    <span class={severityClass(issue.severity)}>{issue.severity ?? props._(P.severityInfo)}</span>
                  </div>
                  <div class="mt-1 line-clamp-2 text-11-regular text-text-weak">{issue.message}</div>
                  <div class="mt-1 text-11-regular text-text-weaker">
                    {[
                      issue.module,
                      formatTime(issue.lastSeenTime, props.fmt),
                      issue.traceId ? props._(P.issueTraceAvailable) : undefined,
                    ]
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

function ToolFailures(props: { _: ReturnType<typeof useLingui>["_"]; items: ToolFailureItem[] }) {
  return (
    <div class="performance-card rounded-xl p-4">
      <div class="mb-3 flex items-center gap-2">
        <Icon name={getSemanticIcon("performance.tools")} size="small" class="text-icon-weak-base" />
        <div>
          <h3 class="text-14-semibold text-text-strong">{props._(P.toolFailures)}</h3>
          <p class="mt-1 text-11-regular text-text-weak">{props._(P.toolFailuresDesc)}</p>
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
                    <div class="truncate text-12-medium text-text-strong">{item.tool}</div>
                    <div class="mt-0.5 truncate text-11-regular text-text-weaker">
                      {typeof cats === "string" ? cats : props._(cats)}
                    </div>
                  </div>
                  <div class="shrink-0 text-right tabular-nums">
                    <div class="text-11-medium text-text-weak">
                      {item.errorCount} {props._(P.toolFailuresFailed)} · {formatChartPercent(item.errorRate * 100)}
                    </div>
                    <div class="mt-0.5 text-11-regular text-text-weaker">
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

function TopRankings(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
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
        <h3 class="text-14-semibold text-text-strong">{props._(P.topRankings)}</h3>
      </div>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <For each={groups()}>
          {(group) => (
            <div>
              <div class="mb-2 text-11-medium uppercase tracking-[0.12em] text-text-weaker">{props._(group.title)}</div>
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
    </div>
  )
}

function BrowserMetricsChart(props: { _: ReturnType<typeof useLingui>["_"]; samples: BrowserMetricSample[] }) {
  const chartTheme = useChartTheme()
  const colors = createMemo(() => {
    const colors = chartTheme()
    return {
      browser: colors.color("syntax-type"),
      memory: colors.color("text-on-success-base"),
      request: colors.color("text-on-warning-base"),
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
        megabytesDataset("Heap used", "memory", colors().browser, "Local performance.memory sample"),
        countDataset("DOM nodes", "domNodes", colors().memory, "Local DOM sample"),
        durationDataset("Navigation duration", "latency", colors().request, "Local navigation timing sample"),
      ]}
      quality={memoryUnsupported() ? P.chartBrowserMemoryUnsupported : undefined}
    />
  )
}

function FrontendSection(props: {
  _: ReturnType<typeof useLingui>["_"]
  summary: PerformanceSummary | null | undefined
}) {
  const frontend = () => props.summary?.frontend
  const slow = () => props.summary?.top.slowFrontend ?? []
  return (
    <div class="performance-frontend-grid">
      <div class="performance-card rounded-xl p-4">
        <div class="mb-3 flex items-center gap-2">
          <Icon name={getSemanticIcon("performance.frontend")} size="small" class="text-icon-weak-base" />
          <h3 class="text-14-semibold text-text-strong">{props._(P.frontendSlow)}</h3>
        </div>
        <Show when={slow().length > 0} fallback={<EmptyState _={props._} label={P.frontendNoSlow} />}>
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
          <Icon name={getSemanticIcon("performance.vitals")} size="small" class="text-icon-weak-base" />
          <h3 class="text-14-semibold text-text-strong">{props._(P.frontendVitals)}</h3>
        </div>
        <div class="grid grid-cols-2 gap-2 text-12-regular">
          <Vital label="INP" value={formatChartDuration(frontend()?.inpMs)} />
          <Vital label="LCP" value={formatChartDuration(frontend()?.lcpMs)} />
          <Vital label="CLS" value={formatDecimal(frontend()?.cls)} />
          <Vital label="FCP" value={formatChartDuration(frontend()?.fcpMs)} />
          <Vital label="TTFB" value={formatChartDuration(frontend()?.ttfbMs)} />
          <Vital label={props._(P.frontendResourceP95)} value={formatChartDuration(frontend()?.resourceP95Ms)} />
          <Vital label={props._(P.summaryLongTasks)} value={String(frontend()?.longTaskCount ?? 0)} />
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
  _: ReturnType<typeof useLingui>["_"]
  fmt: ReturnType<typeof useLocale>["fmt"]
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
                    fallback={
                      <KobalteDialog.Title data-slot="dialog-title">{props._(P.traceDetail)}</KobalteDialog.Title>
                    }
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
                      <DetailRow _={props._} label={P.traceStatus} value={trace().status ?? props._(P.traceUnknown)} />
                      <DetailRow _={props._} label={P.traceDuration} value={formatChartDuration(trace().durationMs)} />
                      <DetailRow _={props._} label={P.traceModule} value={trace().module ?? "—"} />
                      <DetailRow _={props._} label={P.traceSession} value={trace().sessionID ?? "—"} />
                      <DetailRow _={props._} label={P.traceStart} value={formatTime(trace().startedAt, props.fmt)} />
                      <DetailRow _={props._} label={P.traceEnd} value={formatTime(trace().endedAt, props.fmt)} />
                      <Show when={trace().errorCode}>
                        <div class="performance-card-soft rounded-lg p-3 text-icon-warning-base">
                          {trace().errorCode}
                        </div>
                      </Show>
                      <Show when={props.detail?.spans.length}>
                        <div>
                          <div class="mb-2 text-11-medium uppercase tracking-[0.12em] text-text-weaker">
                            {props._(P.traceSpans)}
                          </div>
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
                          <div class="mb-2 text-11-medium uppercase tracking-[0.12em] text-text-weaker">
                            {props._(P.traceEvents)}
                          </div>
                          <div class="flex flex-col gap-1.5">
                            <For each={(props.detail?.events ?? []).slice(0, 20)}>
                              {(event) => (
                                <div class="performance-card-soft rounded-lg px-3 py-2">
                                  <div class="truncate text-12-medium text-text-strong">{event.type}</div>
                                  <div class="mt-1 text-11-regular text-text-weaker">
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
              </div>
            </KobalteDialog.Content>
          </div>
        </div>
      </KobalteDialog.Portal>
    </KobalteDialog>
  )
}

function DetailRow(props: { _: ReturnType<typeof useLingui>["_"]; label: MessageDescriptor; value: string }) {
  return (
    <div class="flex items-center justify-between gap-3 border-b border-border-weaker-base/70 pb-2">
      <span class="text-text-weaker">{props._(props.label)}</span>
      <span class="truncate text-text-base">{props.value}</span>
    </div>
  )
}

function EmptyState(props: { _: ReturnType<typeof useLingui>["_"]; label: MessageDescriptor }) {
  return (
    <div class="performance-card-soft rounded-lg px-3 py-8 text-center text-12-regular text-text-weaker">
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
    axisTitle: "Percent",
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
    axisTitle: "Milliseconds",
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
    axisTitle: "Memory (MB)",
    formatter: (value) => `${value.toFixed(value >= 10 ? 0 : 1)} MB`,
  }
}

function countDataset(
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
