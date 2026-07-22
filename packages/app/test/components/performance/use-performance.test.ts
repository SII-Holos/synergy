import { describe, expect, test } from "bun:test"
import { createRoot, sharedConfig } from "solid-js"
import { usePerformance } from "../../../src/components/performance/use-performance"

describe("performance refresh", () => {
  test("does not schedule or trigger background dashboard loads", async () => {
    let summaryCalls = 0
    let timelineCalls = 0
    let traceListCalls = 0
    const scheduledTimeouts: Array<() => void> = []
    const scheduledIntervals: Array<() => void> = []
    const originalSetTimeout = window.setTimeout
    const originalSetInterval = window.setInterval
    const originalClearTimeout = window.clearTimeout
    const originalClearInterval = window.clearInterval
    const originalEventSource = globalThis.EventSource
    const originalHydrationContext = sharedConfig.context

    window.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === "function") scheduledTimeouts.push(handler as () => void)
      return scheduledTimeouts.length
    }) as typeof window.setTimeout
    window.setInterval = ((handler: TimerHandler) => {
      if (typeof handler === "function") scheduledIntervals.push(handler as () => void)
      return scheduledIntervals.length
    }) as typeof window.setInterval
    window.clearTimeout = (() => undefined) as typeof window.clearTimeout
    window.clearInterval = (() => undefined) as typeof window.clearInterval
    FakeEventSource.connections = 0
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    sharedConfig.context = { id: "", count: 0, async: true, resources: {} } as never

    const sdk = {
      url: "http://localhost",
      client: {
        performance: {
          summary: async () => {
            summaryCalls++
            return { data: null }
          },
          timeline: async () => {
            timelineCalls++
            return { data: null }
          },
          traces: {
            list: async () => {
              traceListCalls++
              return { data: { items: [] } }
            },
            detail: async () => ({ data: null }),
          },
          analysis: {
            start: async () => ({ data: null }),
            get: async () => ({ data: null }),
            cancel: async () => ({ data: null }),
          },
        },
      },
    }
    let dispose: (() => void) | undefined

    try {
      createRoot((rootDispose) => {
        dispose = rootDispose
        void (usePerformance as unknown as (input: typeof sdk) => ReturnType<typeof usePerformance>)(sdk)
      })
      await settle()
      expect(summaryCalls).toBe(1)
      expect(timelineCalls).toBe(1)
      expect(traceListCalls).toBe(1)
      expect(FakeEventSource.connections).toBe(0)
      expect(scheduledTimeouts).toHaveLength(0)
      expect(scheduledIntervals).toHaveLength(0)

      for (const callback of scheduledTimeouts.splice(0)) callback()
      for (const callback of scheduledIntervals.splice(0)) callback()
      document.dispatchEvent(new Event("visibilitychange"))
      await settle()

      expect(summaryCalls).toBe(1)
      expect(timelineCalls).toBe(1)
      expect(traceListCalls).toBe(1)
    } finally {
      dispose?.()
      window.setTimeout = originalSetTimeout
      window.setInterval = originalSetInterval
      window.clearTimeout = originalClearTimeout
      window.clearInterval = originalClearInterval
      globalThis.EventSource = originalEventSource
      sharedConfig.context = originalHydrationContext
    }
  })

  test("continues polling an active analysis after a transient read failure", async () => {
    const scheduledTimeouts: Array<{ callback: () => void; delay: number }> = []
    const originalSetTimeout = window.setTimeout
    const originalClearTimeout = window.clearTimeout
    const originalHydrationContext = sharedConfig.context
    let analysisReads = 0

    window.setTimeout = ((handler: TimerHandler, delay?: number) => {
      if (typeof handler === "function") scheduledTimeouts.push({ callback: handler as () => void, delay: delay ?? 0 })
      return scheduledTimeouts.length
    }) as typeof window.setTimeout
    window.clearTimeout = (() => undefined) as typeof window.clearTimeout
    sharedConfig.context = { id: "", count: 0, async: true, resources: {} } as never

    const queued = {
      sessionID: "ses_analysis",
      status: "queued" as const,
      startedAt: 1,
    }
    const sdk = {
      url: "http://localhost",
      client: {
        performance: {
          summary: async () => ({ data: null }),
          timeline: async () => ({ data: null }),
          traces: {
            list: async () => ({ data: { items: [] } }),
            detail: async () => ({ data: null }),
          },
          analysis: {
            start: async () => ({ data: queued }),
            get: async () => {
              analysisReads++
              if (analysisReads === 1) throw new Error("temporary network failure")
              return { data: { ...queued, status: "completed" as const, completedAt: 2, result: "Healthy" } }
            },
            cancel: async () => ({ data: { ...queued, status: "cancelled" as const } }),
          },
        },
      },
    }
    let dispose: (() => void) | undefined
    let perf: ReturnType<typeof usePerformance> | undefined

    try {
      createRoot((rootDispose) => {
        dispose = rootDispose
        perf = (usePerformance as unknown as (input: typeof sdk) => ReturnType<typeof usePerformance>)(sdk)
      })
      await settle()

      await perf!.startAnalysis()
      expect(scheduledTimeouts).toHaveLength(1)
      expect(scheduledTimeouts[0]?.delay).toBe(1_000)

      scheduledTimeouts.shift()!.callback()
      await settle()
      expect(perf!.analysisError()).toBe("temporary network failure")
      expect(perf!.analysis()?.status).toBe("queued")
      expect(scheduledTimeouts).toHaveLength(1)
      expect(scheduledTimeouts[0]?.delay).toBe(2_000)

      scheduledTimeouts.shift()!.callback()
      await settle()
      expect(perf!.analysisError()).toBeNull()
      expect(perf!.analysis()).toMatchObject({ status: "completed", result: "Healthy" })
      expect(scheduledTimeouts).toHaveLength(0)
    } finally {
      dispose?.()
      window.setTimeout = originalSetTimeout
      window.clearTimeout = originalClearTimeout
      sharedConfig.context = originalHydrationContext
    }
  })

  test("prevents concurrent analysis starts", async () => {
    const originalHydrationContext = sharedConfig.context
    sharedConfig.context = { id: "", count: 0, async: true, resources: {} } as never
    let startCalls = 0
    let releaseStart: () => void = () => undefined
    const pendingStart = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const sdk = {
      url: "http://localhost",
      client: {
        performance: {
          summary: async () => ({ data: null }),
          timeline: async () => ({ data: null }),
          traces: {
            list: async () => ({ data: { items: [] } }),
            detail: async () => ({ data: null }),
          },
          analysis: {
            start: async () => {
              startCalls++
              await pendingStart
              return { data: null }
            },
            get: async () => ({ data: null }),
            cancel: async () => ({ data: null }),
          },
        },
      },
    }
    let dispose: (() => void) | undefined
    let perf: ReturnType<typeof usePerformance> | undefined

    try {
      createRoot((rootDispose) => {
        dispose = rootDispose
        perf = (usePerformance as unknown as (input: typeof sdk) => ReturnType<typeof usePerformance>)(sdk)
      })
      await settle()

      const first = perf!.startAnalysis()
      const second = perf!.startAnalysis()
      expect(startCalls).toBe(1)
      releaseStart()
      await Promise.all([first, second])
      expect(startCalls).toBe(1)
    } finally {
      dispose?.()
      sharedConfig.context = originalHydrationContext
    }
  })

  test("shows the structured server message when analysis cannot start", async () => {
    const originalHydrationContext = sharedConfig.context
    sharedConfig.context = { id: "", count: 0, async: true, resources: {} } as never
    const sdk = {
      url: "http://localhost",
      client: {
        performance: {
          summary: async () => ({ data: null }),
          timeline: async () => ({ data: null }),
          traces: {
            list: async () => ({ data: { items: [] } }),
            detail: async () => ({ data: null }),
          },
          analysis: {
            start: async () => {
              throw {
                code: "PERF_ANALYSIS_UNAVAILABLE",
                message: "Performance analysis requires an available Thinking model.",
              }
            },
            get: async () => ({ data: null }),
            cancel: async () => ({ data: null }),
          },
        },
      },
    }
    let dispose: (() => void) | undefined
    let perf: ReturnType<typeof usePerformance> | undefined

    try {
      createRoot((rootDispose) => {
        dispose = rootDispose
        perf = (usePerformance as unknown as (input: typeof sdk) => ReturnType<typeof usePerformance>)(sdk)
      })
      await settle()

      await perf!.startAnalysis()
      expect(perf!.analysisError()).toBe("Performance analysis requires an available Thinking model.")
    } finally {
      dispose?.()
      sharedConfig.context = originalHydrationContext
    }
  })
})

class FakeEventSource {
  static connections = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    FakeEventSource.connections++
  }

  addEventListener() {}
  close() {}
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
