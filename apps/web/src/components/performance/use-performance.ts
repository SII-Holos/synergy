import { createResource, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { isPerformanceAnalysisActive } from "./analysis-model"
import { CHART_METRICS } from "./chart-model"
import type {
  BrowserMetricSample,
  PerformanceAnalysis,
  PerformanceSummary,
  PerformanceTimeline,
  PerformanceTraceDetail,
  PerformanceTraceSpan,
} from "./types"

function getErrorMessage(error: unknown) {
  return requestErrorMessage(error, "Unable to load performance data right now.")
}

function readPerformanceMemory(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
  if (!memory?.usedJSHeapSize) return undefined
  return memory.usedJSHeapSize
}

function readBrowserSample(): BrowserMetricSample {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
  return {
    timestamp: Date.now(),
    memory: readPerformanceMemory(),
    domNodes: document.getElementsByTagName("*").length,
    navigationMs: navigation ? Math.round(navigation.duration) : undefined,
  }
}

type PerformanceSnapshot = {
  windowMs: number
  attemptedAt: number
  summary: PerformanceSummary | null
  error: string | null
}

export function usePerformance(input?: ReturnType<typeof useGlobalSDK>) {
  const sdk = input ?? useGlobalSDK()
  const [browserSamples, setBrowserSamples] = createSignal<BrowserMetricSample[]>([])
  const [eventTraces, setEventTraces] = createSignal<PerformanceTraceSpan[]>([])
  const [windowMs, setWindowMs] = createSignal(900_000)
  const [timeline, setTimeline] = createSignal<PerformanceTimeline | null>(null)
  const [timelineError, setTimelineError] = createSignal<string | null>(null)
  const [tracesError, setTracesError] = createSignal<string | null>(null)
  const [timelineLoading, setTimelineLoading] = createSignal(false)
  const [tracesLoading, setTracesLoading] = createSignal(false)
  const [traceDetail, setTraceDetail] = createSignal<PerformanceTraceDetail | null>(null)
  const [analysis, setAnalysis] = createSignal<PerformanceAnalysis | null>(null)
  const [analysisError, setAnalysisError] = createSignal<string | null>(null)
  const [analysisStarting, setAnalysisStarting] = createSignal(false)

  let requestVersion = 0
  let detailVersion = 0
  const [snapshot, { refetch }] = createResource<PerformanceSnapshot, number>(
    windowMs,
    async (rangeMs, { value }): Promise<PerformanceSnapshot> => {
      const version = ++requestVersion
      const attemptedAt = Date.now()
      const previous = value?.windowMs === rangeMs ? value : undefined
      if (!previous) {
        detailVersion++
        setTimeline(null)
        setEventTraces([])
        setTimelineError(null)
        setTracesError(null)
        setTimelineLoading(false)
        setTracesLoading(false)
      }
      try {
        const result = await sdk.client.performance.summary({ windowMs: rangeMs }, { throwOnError: true })
        if (version === requestVersion) {
          setTimeline(null)
          setEventTraces([])
          const details = ++detailVersion
          void loadTraces(rangeMs, details)
          void loadTimeline(rangeMs, details)
        }
        return { windowMs: rangeMs, attemptedAt, summary: result.data ?? null, error: null }
      } catch (err) {
        return {
          windowMs: rangeMs,
          attemptedAt,
          summary: previous?.summary ?? null,
          error: getErrorMessage(err),
        }
      }
    },
  )
  const currentSnapshot = () => {
    const value = snapshot()
    return value?.windowMs === windowMs() ? value : undefined
  }
  const summary = () => currentSnapshot()?.summary ?? null
  const error = () => (snapshot.loading ? null : (currentSnapshot()?.error ?? null))

  const sampleBrowser = () => {
    setBrowserSamples((items: BrowserMetricSample[]) => [...items, readBrowserSample()].slice(-60))
  }
  sampleBrowser()
  let analysisPollTimer: number | undefined
  let analysisPollFailures = 0

  onCleanup(() => {
    requestVersion++
    detailVersion++
    window.clearTimeout(analysisPollTimer)
  })

  return {
    summary,
    get loading() {
      return snapshot.loading
    },
    error,
    attemptedAt: () => currentSnapshot()?.attemptedAt,
    windowMs,
    setWindowMs,
    timeline,
    timelineError,
    tracesError,
    timelineLoading,
    tracesLoading,
    traceDetail,
    analysis,
    analysisError,
    analysisStarting,
    browserSamples,
    eventTraces,
    refresh: refreshAll,
    loadTrace,
    loadTimeline,
    startAnalysis,
    cancelAnalysis,
  }

  async function refreshAll() {
    sampleBrowser()
    return refetch()
  }

  async function loadTimeline(rangeMs = windowMs(), version = detailVersion) {
    setTimelineError(null)
    setTimelineLoading(true)
    try {
      const now = Date.now()
      const result = await sdk.client.performance.timeline(
        { from: new Date(now - rangeMs).toISOString(), metric: CHART_METRICS },
        { throwOnError: true },
      )
      if (version === detailVersion && rangeMs === windowMs()) setTimeline(result.data ?? null)
    } catch (err) {
      if (version === detailVersion && rangeMs === windowMs()) setTimelineError(getErrorMessage(err))
    } finally {
      if (version === detailVersion && rangeMs === windowMs()) setTimelineLoading(false)
    }
  }

  async function loadTraces(rangeMs = windowMs(), version = detailVersion) {
    setTracesError(null)
    setTracesLoading(true)
    try {
      const now = Date.now()
      const result = await sdk.client.performance.traces.list(
        { from: new Date(now - rangeMs).toISOString(), limit: 24 },
        { throwOnError: true },
      )
      if (version === detailVersion && rangeMs === windowMs()) setEventTraces(result.data?.items ?? [])
    } catch (err) {
      if (version === detailVersion && rangeMs === windowMs()) setTracesError(getErrorMessage(err))
    } finally {
      if (version === detailVersion && rangeMs === windowMs()) setTracesLoading(false)
    }
  }

  async function loadTrace(traceId: string) {
    const result = await sdk.client.performance.traces.detail({ traceId }, { throwOnError: true })
    setTraceDetail(result.data ?? null)
    return result.data ?? null
  }

  async function startAnalysis() {
    const current = analysis()
    if (analysisStarting() || (current && isPerformanceAnalysisActive(current.status))) return current
    window.clearTimeout(analysisPollTimer)
    setAnalysisError(null)
    setAnalysis(null)
    analysisPollFailures = 0

    setAnalysisStarting(true)
    try {
      const result = await sdk.client.performance.analysis.start(
        { performanceAnalysisRequest: { windowMs: windowMs() } },
        { throwOnError: true },
      )
      const next = result.data ?? null
      setAnalysis(next)
      if (next && isPerformanceAnalysisActive(next.status)) scheduleAnalysisPoll(next.sessionID)
      return next
    } catch (err) {
      setAnalysisError(getErrorMessage(err))
      return null
    } finally {
      setAnalysisStarting(false)
    }
  }

  async function loadAnalysis(sessionID: string) {
    try {
      const result = await sdk.client.performance.analysis.get({ sessionID }, { throwOnError: true })
      const next = result.data ?? null
      setAnalysisError(null)
      analysisPollFailures = 0
      setAnalysis(next)
      if (next && isPerformanceAnalysisActive(next.status)) scheduleAnalysisPoll(sessionID)
      return next
    } catch (err) {
      setAnalysisError(getErrorMessage(err))
      analysisPollFailures++
      const current = analysis()
      if (current?.sessionID === sessionID && isPerformanceAnalysisActive(current.status)) {
        scheduleAnalysisPoll(sessionID, Math.min(1_000 * 2 ** analysisPollFailures, 16_000))
      }
      return null
    }
  }

  function scheduleAnalysisPoll(sessionID: string, delayMs = 1_000) {
    window.clearTimeout(analysisPollTimer)
    analysisPollTimer = window.setTimeout(() => void loadAnalysis(sessionID), delayMs)
  }

  async function cancelAnalysis() {
    const current = analysis()
    if (!current || !isPerformanceAnalysisActive(current.status)) return current
    window.clearTimeout(analysisPollTimer)
    setAnalysisError(null)
    try {
      const result = await sdk.client.performance.analysis.cancel(
        { sessionID: current.sessionID },
        { throwOnError: true },
      )
      const next = result.data ?? null
      setAnalysis(next)
      if (next && isPerformanceAnalysisActive(next.status)) scheduleAnalysisPoll(next.sessionID)
      return next
    } catch (err) {
      setAnalysisError(getErrorMessage(err))
      if (isPerformanceAnalysisActive(current.status)) scheduleAnalysisPoll(current.sessionID)
      return null
    }
  }
}
