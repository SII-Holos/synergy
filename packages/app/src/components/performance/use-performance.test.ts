import { describe, expect, test } from "bun:test"
import { createRoot, sharedConfig } from "solid-js"
import { usePerformance } from "./use-performance"

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
