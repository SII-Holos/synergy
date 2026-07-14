import { createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { CHART_METRICS } from "./chart-model"
import type {
  BrowserMetricSample,
  PerformanceSummary,
  PerformanceTimeline,
  PerformanceTraceDetail,
  PerformanceTraceSpan,
} from "./types"

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  return "Unable to load performance data right now."
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

export function usePerformance(input?: ReturnType<typeof useGlobalSDK>) {
  const sdk = input ?? useGlobalSDK()
  const [error, setError] = createSignal<string | null>(null)
  const [browserSamples, setBrowserSamples] = createSignal<BrowserMetricSample[]>([])
  const [eventTraces, setEventTraces] = createSignal<PerformanceTraceSpan[]>([])
  const [windowMs, setWindowMs] = createSignal(900_000)
  const [timeline, setTimeline] = createSignal<PerformanceTimeline | null>(null)
  const [traceDetail, setTraceDetail] = createSignal<PerformanceTraceDetail | null>(null)

  const [summary, { refetch }] = createResource(windowMs, async (rangeMs): Promise<PerformanceSummary | null> => {
    try {
      setError(null)
      const summaryResult = await sdk.client.performance.summary({ windowMs: rangeMs }, { throwOnError: true })
      void loadTraces(rangeMs)
      void loadTimeline(rangeMs)
      return summaryResult.data ?? null
    } catch (err) {
      setError(getErrorMessage(err))
      return null
    }
  })

  const sampleBrowser = () => {
    setBrowserSamples((items: BrowserMetricSample[]) => [...items, readBrowserSample()].slice(-60))
  }
  sampleBrowser()

  return {
    summary,
    loading: summary.loading,
    error,
    windowMs,
    setWindowMs,
    timeline,
    traceDetail,
    browserSamples,
    eventTraces,
    refresh: refreshAll,
    loadTrace,
    loadTimeline,
  }

  async function refreshAll() {
    sampleBrowser()
    return refetch()
  }

  async function loadTimeline(rangeMs = windowMs()) {
    const now = Date.now()
    const result = await sdk.client.performance.timeline(
      { from: new Date(now - rangeMs).toISOString(), metric: CHART_METRICS },
      { throwOnError: true },
    )

    setTimeline(result.data ?? null)
  }

  async function loadTraces(rangeMs = windowMs()) {
    try {
      const now = Date.now()
      const result = await sdk.client.performance.traces.list(
        { from: new Date(now - rangeMs).toISOString(), limit: 24 },
        { throwOnError: true },
      )
      setEventTraces(result.data?.items ?? [])
    } catch {
      setEventTraces([])
    }
  }

  async function loadTrace(traceId: string) {
    const result = await sdk.client.performance.traces.detail({ traceId }, { throwOnError: true })
    setTraceDetail(result.data ?? null)
    return result.data ?? null
  }
}
