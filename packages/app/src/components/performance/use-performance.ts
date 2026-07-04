import { createResource, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import type {
  BrowserMetricSample,
  PerformanceEvent,
  PerformanceIssue,
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

export function usePerformance() {
  const sdk = useGlobalSDK()
  const [error, setError] = createSignal<string | null>(null)
  const [streamError, setStreamError] = createSignal<string | null>(null)
  const [connected, setConnected] = createSignal(false)
  const [browserSamples, setBrowserSamples] = createSignal<BrowserMetricSample[]>([])
  const [eventIssues, setEventIssues] = createSignal<PerformanceIssue[]>([])
  const [eventTraces, setEventTraces] = createSignal<PerformanceTraceSpan[]>([])
  const [windowMs, setWindowMs] = createSignal(900_000)
  const [timeline, setTimeline] = createSignal<PerformanceTimeline | null>(null)
  const [traceDetail, setTraceDetail] = createSignal<PerformanceTraceDetail | null>(null)

  const [summary, { refetch, mutate }] = createResource(
    windowMs,
    async (rangeMs): Promise<PerformanceSummary | null> => {
      try {
        setError(null)
        const summaryResult = await sdk.client.performance.summary({ windowMs: rangeMs }, { throwOnError: true })
        void loadTraces(rangeMs)
        return summaryResult.data ?? null
      } catch (err) {
        setError(getErrorMessage(err))
        return null
      }
    },
  )

  const stream = new EventSource(`${sdk.url}/global/performance/events`)

  stream.onopen = () => {
    setConnected(true)
    setStreamError(null)
  }

  const handleMessage = (event: MessageEvent) => {
    const payload = parsePerformanceEvent(event)
    if (!payload) return

    if (payload.type === "summary" && payload.summary) {
      mutate(() => payload.summary!)
      return
    }

    if (payload.type === "trace" && payload.trace) {
      setEventTraces((items: PerformanceTraceSpan[]) => [payload.trace!, ...items].slice(0, 20))
      return
    }

    if (payload.type === "issue" && payload.issue) {
      setEventIssues((items: PerformanceIssue[]) => [payload.issue!, ...items].slice(0, 20))
      return
    }

    if (payload.type === "browser" && payload.sample) {
      setBrowserSamples((items: BrowserMetricSample[]) => [...items, payload.sample!].slice(-60))
      return
    }

    if (payload.type === "error") {
      setStreamError(payload.message ?? "Performance event stream reported an error.")
    }
  }

  stream.onmessage = handleMessage
  stream.addEventListener("performance.summary.updated", handleMessage)
  stream.addEventListener("performance.issue.raised", handleMessage)
  stream.addEventListener("performance.trace.ended", handleMessage)

  stream.onerror = () => {
    setConnected(false)
    setStreamError("Performance event stream disconnected.")
  }

  const sampleBrowser = () => {
    if (document.hidden) return
    setBrowserSamples((items: BrowserMetricSample[]) => [...items, readBrowserSample()].slice(-60))
  }
  sampleBrowser()
  const browserTimer = window.setInterval(sampleBrowser, 10_000)
  let pollTimer: number | undefined
  const schedulePoll = () => {
    window.clearTimeout(pollTimer)
    pollTimer = window.setTimeout(() => {
      if (!document.hidden) void refreshAll()
      schedulePoll()
    }, performancePollInterval(connected()))
  }
  schedulePoll()

  const onVisibility = () => {
    if (document.hidden) return
    sampleBrowser()
    void refreshAll()
    schedulePoll()
  }
  document.addEventListener("visibilitychange", onVisibility)

  onCleanup(() => {
    stream.close()
    window.clearInterval(browserTimer)
    window.clearTimeout(pollTimer)
    document.removeEventListener("visibilitychange", onVisibility)
  })

  return {
    summary,
    loading: summary.loading,
    error,
    streamError,
    connected,
    windowMs,
    setWindowMs,
    timeline,
    traceDetail,
    browserSamples,
    eventIssues,
    eventTraces,
    refresh: refreshAll,
    loadTrace,
    loadTimeline,
  }

  async function refreshAll() {
    const result = await refetch()
    void loadTraces(windowMs())
    return result
  }

  async function loadTimeline(rangeMs = windowMs()) {
    const now = Date.now()
    const result = await sdk.client.performance.timeline(
      { from: new Date(now - rangeMs).toISOString() },
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

  function parsePerformanceEvent(event: MessageEvent): PerformanceEvent | undefined {
    try {
      const data = JSON.parse(event.data) as unknown
      if (typeof data === "object" && data && "type" in data) return data as PerformanceEvent
      if (event.type === "performance.summary.updated") return { type: "summary", summary: data as PerformanceSummary }
      if (event.type === "performance.issue.raised") return { type: "issue", issue: data as PerformanceIssue }
      if (event.type === "performance.trace.ended") return { type: "trace", trace: data as PerformanceTraceSpan }
    } catch {
      return undefined
    }
  }
}

export function performancePollInterval(connected: boolean) {
  return connected ? 30_000 : 10_000
}
