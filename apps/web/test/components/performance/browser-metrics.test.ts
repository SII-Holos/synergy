import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  browserPerformanceEnabled,
  browserTokenDurationSampleRate,
  buildSessionSwitchMetrics,
  buildTokenTimingMetric,
  drainTokenDurationMetrics,
  fitBrowserMetricBatch,
  mergeTokenReceipt,
  pageContextFromUrl,
  recordTokenApply,
  recordTokenReceive,
  startBrowserPerformanceMetrics,
  shouldRetryBrowserMetricBatch,
  stopBrowserPerformanceMetrics,
} from "../../../src/components/performance/browser-metrics"

describe("browser performance effective enablement", () => {
  test("defaults to enabled when no observability config is present", () => {
    expect(browserPerformanceEnabled()).toBe(true)
    expect(browserPerformanceEnabled({})).toBe(true)
  })

  test("honors explicit performance.enabled", () => {
    expect(browserPerformanceEnabled({ observability: { performance: { enabled: false } } })).toBe(false)
    expect(browserPerformanceEnabled({ observability: { performance: { enabled: true } } })).toBe(true)
  })

  test("falls back to the master observability.enabled switch", () => {
    expect(browserPerformanceEnabled({ observability: { enabled: false } })).toBe(false)
    expect(browserPerformanceEnabled({ observability: { enabled: true } })).toBe(true)
  })

  test("performance.enabled wins over the master switch", () => {
    expect(browserPerformanceEnabled({ observability: { enabled: false, performance: { enabled: true } } })).toBe(true)
  })
})

describe("token duration sampling rate", () => {
  test("keeps the low default while the operator leaves the rate unset", () => {
    expect(browserTokenDurationSampleRate()).toBe(0.1)
    expect(browserTokenDurationSampleRate({})).toBe(0.1)
    expect(browserTokenDurationSampleRate({ observability: { performance: { enabled: true } } })).toBe(0.1)
  })

  test("honors an explicitly configured rate including its bounds", () => {
    expect(browserTokenDurationSampleRate({ observability: { performance: { samplingRate: 0.25 } } })).toBe(0.25)
    expect(browserTokenDurationSampleRate({ observability: { performance: { samplingRate: 1 } } })).toBe(1)
    expect(browserTokenDurationSampleRate({ observability: { performance: { samplingRate: 0 } } })).toBe(0)
  })

  test("keeps the low default for a config that leaves the rate unset", async () => {
    const part = { id: "prt_unset", sessionID: "ses_1", messageID: "msg_1", type: "text" }
    const originalRandom = Math.random
    Math.random = () => 0.5
    try {
      startBrowserPerformanceMetrics({
        url: "http://localhost/",
        client: {} as never,
        tokenDurationSampleRate: browserTokenDurationSampleRate({ observability: { performance: { enabled: true } } }),
      })
      recordTokenReceive(part, { delta: "abcd" })
      recordTokenApply(part)
      await Bun.sleep(10)
      expect(drainTokenDurationMetrics()).toEqual([])
    } finally {
      Math.random = originalRandom
      stopBrowserPerformanceMetrics()
    }
  })

  test("honors an explicitly configured rate when apply and paint drain", async () => {
    const part = { id: "prt_configured", sessionID: "ses_1", messageID: "msg_1", type: "text" }
    const originalRandom = Math.random
    Math.random = () => 0.5
    try {
      startBrowserPerformanceMetrics({
        url: "http://localhost/",
        client: {} as never,
        tokenDurationSampleRate: browserTokenDurationSampleRate({
          observability: { performance: { samplingRate: 0.6 } },
        }),
      })
      recordTokenReceive(part, { delta: "abcd" })
      recordTokenApply(part)
      await Bun.sleep(10)
      expect(
        drainTokenDurationMetrics()
          .map((metric) => metric.name)
          .sort(),
      ).toEqual(["frontend.token.apply.duration", "frontend.token.paint.duration"])
    } finally {
      Math.random = originalRandom
      stopBrowserPerformanceMetrics()
    }
  })

  test("applies a changed rate to an already-running collector", async () => {
    const part = { id: "prt_rate_change", sessionID: "ses_1", messageID: "msg_1", type: "text" }
    const originalRandom = Math.random
    Math.random = () => 0.5
    try {
      startBrowserPerformanceMetrics({ url: "http://localhost/", client: {} as never, tokenDurationSampleRate: 0.1 })
      startBrowserPerformanceMetrics({ url: "http://localhost/", client: {} as never, tokenDurationSampleRate: 0.6 })
      recordTokenReceive(part, { delta: "abcd" })
      recordTokenApply(part)
      await Bun.sleep(10)
      expect(
        drainTokenDurationMetrics()
          .map((metric) => metric.name)
          .sort(),
      ).toEqual(["frontend.token.apply.duration", "frontend.token.paint.duration"])
    } finally {
      Math.random = originalRandom
      stopBrowserPerformanceMetrics()
    }
  })
})

describe("browser performance metrics", () => {
  test("builds safe route and session context", () => {
    expect(pageContextFromUrl("/session/1234567890abcdef", "?sessionID=ses_abc-123&scopeID=scope:def")).toEqual({
      routeName: "session.1234567890abcdef",
      pathTemplate: "/session/:id",
      sessionID: "ses_abc-123",
      scopeID: "scope:def",
    })
  })

  test("strips unsafe context characters and query data", () => {
    expect(
      pageContextFromUrl("/files/super-secret-token-value", "?sessionID=ses_abc%0Asecret&scopeID=<scope>"),
    ).toEqual({
      routeName: "files.super-secret-token-value",
      pathTemplate: "/files/super-secret-token-value",
      sessionID: "ses_abcsecret",
      scopeID: "scope",
    })
  })

  test("builds safe session switch timing metrics", () => {
    const metrics = buildSessionSwitchMetrics({
      sessionID: "ses_1",
      scopeID: "scope_1",
      correlationId: "corr_1",
      navigationId: "nav_1",
      sessionSwitchId: "switch_1",
      startTime: 100,
      endTime: 220,
      marks: { "session:data-ready": 140, "session:first-turn-mounted": 200 },
      reason: "complete",
      trigger: "route",
      longTaskOverlapMs: 16,
    })

    expect(metrics.map((metric) => metric.name)).toEqual([
      "frontend.session_switch.duration",
      "frontend.session_switch.phase.duration",
      "frontend.session_switch.phase.duration",
      "frontend.session_switch.long_task_overlap",
    ])
    expect(metrics[0]).toMatchObject({
      value: 120,
      labels: {
        sessionID: "ses_1",
        scopeID: "scope_1",
        correlationId: "corr_1",
        navigationId: "nav_1",
        sessionSwitchId: "switch_1",
        reason: "complete",
        trigger: "route",
      },
    })
  })

  test("drops invalid timing values", () => {
    expect(
      buildSessionSwitchMetrics({
        sessionID: "ses_1",
        correlationId: "corr_1",
        navigationId: "nav_1",
        sessionSwitchId: "switch_1",
        startTime: 100,
        endTime: 90,
        marks: { "session:data-ready": Number.POSITIVE_INFINITY },
        reason: "timeout",
      }),
    ).toEqual([])

    expect(
      buildTokenTimingMetric({
        phase: "apply",
        value: Number.NaN,
        unit: "ms",
        part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text" },
        receipt: {
          time: 10,
          context: { sessionID: "ses_1", correlationId: "msg_1" },
          deltaChars: 4,
          partType: "text",
        },
      }),
    ).toBeUndefined()
  })

  test("builds token receive/apply/paint timing labels", () => {
    const metric = buildTokenTimingMetric({
      phase: "paint",
      value: 12,
      unit: "ms",
      part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text" },
      receipt: {
        time: 10,
        context: { sessionID: "ses_1", correlationId: "msg_1", navigationId: "nav_1" },
        deltaChars: 4,
        partType: "text",
      },
    })

    expect(metric).toMatchObject({
      name: "frontend.token.paint.duration",
      value: 12,
      unit: "ms",
      labels: {
        sessionID: "ses_1",
        correlationId: "msg_1",
        navigationId: "nav_1",
        phase: "paint",
        tokenPhase: "paint",
        deltaChars: 4,
        messageID: "msg_1",
      },
    })
  })

  test("keeps the first receipt time while a render frame accumulates deltas", () => {
    expect(
      mergeTokenReceipt(
        {
          time: 10,
          context: { sessionID: "ses_1", correlationId: "msg_1" },
          deltaChars: 4,
          partType: "text",
        },
        {
          time: 14,
          context: { sessionID: "ses_1", correlationId: "msg_1" },
          deltaChars: 6,
          partType: "text",
        },
      ),
    ).toEqual({
      time: 10,
      context: { sessionID: "ses_1", correlationId: "msg_1" },
      deltaChars: 10,
      partType: "text",
    })
  })

  test("fits pagehide batches below the browser keepalive payload limit", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      kind: "metric" as const,
      value: {
        name: "frontend.test",
        value: index,
        unit: "count" as const,
        labels: { payload: "x".repeat(1000) },
      },
    }))

    const fitted = fitBrowserMetricBatch({ entries, rejected: 2, page: {}, maxBytes: 60 * 1024 })
    expect(new TextEncoder().encode(JSON.stringify(fitted.body)).byteLength).toBeLessThanOrEqual(60 * 1024)
    expect(fitted.entries.length).toBeGreaterThan(0)
    expect(fitted.entries.length).toBeLessThan(entries.length)
    expect(fitted.entries.length + fitted.deferred.length).toBe(entries.length)
    expect(fitted.body.metrics.at(-1)).toMatchObject({
      name: "frontend.collector.rejected",
      value: 2,
    })
  })
  test("caps metrics at the backend batch limit including the rejected counter", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      kind: "metric" as const,
      value: { name: "frontend.test", value: index, unit: "count" as const, labels: {} },
    }))
    const fitted = fitBrowserMetricBatch({ entries, rejected: 7, page: {}, maxBytes: 256 * 1024 })
    expect(fitted.body.metrics.length).toBe(100)
    expect(fitted.body.metrics.at(-1)).toMatchObject({ name: "frontend.collector.rejected", value: 7 })
    expect(fitted.entries.length).toBe(99)
    expect(fitted.deferred).toEqual([entries.at(-1)!])
    expect(fitted.entries.length + fitted.deferred.length).toBe(entries.length)
  })

  test("defers overflow entries beyond the backend metric limit", () => {
    const entries = Array.from({ length: 150 }, (_, index) => ({
      kind: "metric" as const,
      value: { name: "frontend.test", value: index, unit: "count" as const, labels: {} },
    }))
    const fitted = fitBrowserMetricBatch({ entries, rejected: 0, page: {}, maxBytes: 256 * 1024 })
    expect(fitted.body.metrics.length).toBe(100)
    expect(fitted.entries.length).toBe(100)
    expect(fitted.deferred.length).toBe(50)
  })
  test("does not retry batches the server rejected as invalid", () => {
    expect(
      shouldRetryBrowserMetricBatch({ code: "PERF_INVALID_METRIC_BATCH", message: "Invalid performance request." }),
    ).toBe(false)
    expect(shouldRetryBrowserMetricBatch({ code: "PERF_RATE_LIMITED", retryAfterMs: 1000 })).toBe(true)
    expect(shouldRetryBrowserMetricBatch(new TypeError("fetch failed"))).toBe(true)
  })
})

describe("token duration batching", () => {
  const part = (id: string) => ({ id, sessionID: "ses_1", messageID: "msg_1", type: "text" })

  function withSamplingKept<T>(fn: () => T): T {
    const originalRandom = Math.random
    Math.random = () => 0
    try {
      return fn()
    } finally {
      Math.random = originalRandom
    }
  }

  test("collapses apply and paint into one row per batch across parts of one message", async () => {
    withSamplingKept(() => {
      recordTokenReceive(part("prt_batch_1"), { delta: "abcd" })
      recordTokenApply(part("prt_batch_1"))
      recordTokenReceive(part("prt_batch_2"), { delta: "abcde" })
      recordTokenApply(part("prt_batch_2"))
    })
    await Bun.sleep(5)
    const drained = withSamplingKept(() => drainTokenDurationMetrics())
    stopBrowserPerformanceMetrics()

    expect(drained.map((metric) => metric.name).sort()).toEqual([
      "frontend.token.apply.duration",
      "frontend.token.paint.duration",
    ])
    for (const metric of drained) {
      expect(metric.unit).toBe("ms")
      expect(metric.labels).toMatchObject({
        partType: "text",
        messageID: "msg_1",
        sessionID: "ses_1",
        deltaChars: 9,
      })
    }
  })

  test("samples apply and paint while leaving receive an exact count", async () => {
    const originalRandom = Math.random
    Math.random = () => 0.99
    try {
      recordTokenReceive(part("prt_sample_1"), { delta: "abcd" })
      recordTokenApply(part("prt_sample_1"))
      await Bun.sleep(5)
      expect(drainTokenDurationMetrics()).toEqual([])
    } finally {
      Math.random = originalRandom
      stopBrowserPerformanceMetrics()
    }

    const receive = buildTokenTimingMetric({
      phase: "receive",
      value: 1,
      unit: "count",
      part: part("prt_sample_2"),
      receipt: { time: 0, context: { sessionID: "ses_1" }, deltaChars: 4, partType: "text" },
    })
    expect(receive).toMatchObject({ name: "frontend.token.receive.count", unit: "count", value: 1 })
  })
})

const NAV_MARK_CALL = /navMark\(\{[^}]*?\bname:\s*"([^"]+)"/g
const NAV_MARK_WRITE = /nav\.marks\["([^"]+)"\]/g
const HARNESS_ENUM_ENTRY = /\[\s*"([a-z]+)"\s*,\s*new Set\(\[([\s\S]*?)\]\),?\s*\]/g
const webSourceRoot = fileURLToPath(new URL("../../../src", import.meta.url))
const harnessBrowserMetrics = new URL(
  "../../../../../packages/harness/src/observability/browser-metrics.ts",
  import.meta.url,
)

async function emittedNavMarkNames() {
  const names = new Set<string>()
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  for await (const relativePath of glob.scan({ cwd: webSourceRoot })) {
    const source = await Bun.file(join(webSourceRoot, relativePath)).text()
    for (const match of source.matchAll(NAV_MARK_CALL)) names.add(match[1]!)
    for (const match of source.matchAll(NAV_MARK_WRITE)) names.add(match[1]!)
  }
  return names
}

async function harnessPhaseLabels() {
  const source = await Bun.file(harnessBrowserMetrics).text()
  const start = source.indexOf("const ENUM_LABELS")
  const end = source.indexOf("export function ingest")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const phases = new Set<string>()
  for (const entry of source.slice(start, end).matchAll(HARNESS_ENUM_ENTRY)) {
    if (entry[1] !== "phase") continue
    for (const value of entry[2]!.matchAll(/"([^"]+)"/g)) phases.add(value[1]!)
  }
  return phases
}

describe("session nav phase labels", () => {
  test("registers every emitted session nav mark in the harness phase label enum", async () => {
    const marks = await emittedNavMarkNames()
    const phases = await harnessPhaseLabels()

    expect(marks.size).toBeGreaterThan(0)
    expect(phases.size).toBeGreaterThan(0)
    expect(phases.has("timeout")).toBe(true)
    expect([...marks].filter((mark) => !phases.has(mark)).sort()).toEqual([])
  })
})
