import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, spyOn, test } from "bun:test"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { Provider } from "../../src/provider/provider"

const encoder = new TextEncoder()

type Recorded = {
  name?: string
  value?: number
  unit?: string
  labels?: Record<string, unknown>
}

function recordedRows(spy: ReturnType<typeof spyOn>, name: string): Recorded[] {
  const calls = (spy as unknown as { mock: { calls: Array<Array<Recorded>> } }).mock.calls
  return calls.map((call) => call[0]).filter((row) => row.name === name)
}

/** A body that never produces a byte and never closes. */
function silentBody() {
  return new ReadableStream<Uint8Array>({ start() {} })
}

/** A body that emits one chunk and then stops producing without closing. */
function oneChunkThenSilent(text = "data: first\n\n") {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return
      sent = true
      controller.enqueue(encoder.encode(text))
    },
  })
}

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition was not reached in time")
    await Bun.sleep(5)
  }
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(value)
  }
}

describe("Provider.createTimeoutFetch TTFB clear point", () => {
  test(
    "stays armed when the response headers arrive and no body byte follows",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      let fetchResolved = false
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () => {
          fetchResolved = true
          return new Response(silentBody(), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        },
        noProxy: false,
        // Idle and wall are disabled so TTFB is the only watchdog that can end this request.
        timeouts: { providerTtfbMs: 40, providerIdleMs: false, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})

      // The fetch promise resolved on headers, and headers alone must not disarm TTFB.
      expect(fetchResolved).toBe(true)
      await expect(metrics, "the silent body should be aborted by the TTFB watchdog").toBeDefined()
      const reader = response.body!.getReader()
      await expect(reader.read()).rejects.toMatchObject({
        name: "TimeoutError",
        message: expect.stringMatching(/TTFB timeout/),
      })

      const fired = recordedRows(metrics, "llm.watchdog.fired")
      expect(fired).toHaveLength(1)
      expect(fired[0]).toMatchObject({
        value: 1,
        unit: "count",
        labels: { provider: "test-provider", model: "test-model", kind: "ttfb" },
      })
    }),
  )

  test(
    "records headers but never first_byte for a body that stayed silent",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () =>
          new Response(silentBody(), { status: 200, headers: { "content-type": "text/event-stream" } }),
        noProxy: false,
        timeouts: { providerTtfbMs: 40, providerIdleMs: false, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})
      const reader = response.body!.getReader()
      await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" })

      const headers = recordedRows(metrics, "llm.fetch.headers")
      expect(headers).toHaveLength(1)
      expect(headers[0].unit).toBe("ms")
      expect(typeof headers[0].value).toBe("number")
      expect(headers[0].value!).toBeGreaterThanOrEqual(0)
      // The distinguishing evidence: headers were observed, the first body byte was not.
      expect(recordedRows(metrics, "llm.fetch.first_byte")).toHaveLength(0)
    }),
  )

  test(
    "clears the TTFB watchdog once the first byte of an SSE body arrives",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () =>
          new Response(oneChunkThenSilent(), { status: 200, headers: { "content-type": "text/event-stream" } }),
        noProxy: false,
        timeouts: { providerTtfbMs: 40, providerIdleMs: false, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})
      const reader = response.body!.getReader()
      await reader.read()

      // Wait well past the TTFB threshold: a cleared timer must not fire.
      await Bun.sleep(150)

      const firstByte = recordedRows(metrics, "llm.fetch.first_byte")
      expect(firstByte).toHaveLength(1)
      expect(firstByte[0].unit).toBe("ms")
      expect(typeof firstByte[0].value).toBe("number")
      expect(recordedRows(metrics, "llm.watchdog.fired")).toHaveLength(0)
      await reader.cancel().catch(() => {})
    }),
  )

  test(
    "clears the TTFB watchdog for a non-SSE body as well",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () =>
          new Response(oneChunkThenSilent('{"json":true}'), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        noProxy: false,
        timeouts: { providerTtfbMs: 40, providerIdleMs: false, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})
      const reader = response.body!.getReader()
      await reader.read()

      await Bun.sleep(150)

      expect(recordedRows(metrics, "llm.fetch.first_byte")).toHaveLength(1)
      expect(recordedRows(metrics, "llm.watchdog.fired")).toHaveLength(0)
      await reader.cancel().catch(() => {})
    }),
  )

  test(
    "does not arm a TTFB watchdog when the budget is not positive",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      const caller = new AbortController()
      let captured: AbortSignal | undefined
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async (input, init) => {
          captured = init?.signal ?? (input instanceof Request ? input.signal : undefined)
          return new Response(oneChunkThenSilent(), { status: 200, headers: { "content-type": "text/event-stream" } })
        },
        noProxy: false,
        timeouts: { providerTtfbMs: 0, providerIdleMs: false, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", { signal: caller.signal })
      const reader = response.body!.getReader()
      await reader.read()
      await Bun.sleep(120)

      expect(captured?.aborted).toBe(false)
      expect(recordedRows(metrics, "llm.watchdog.fired")).toHaveLength(0)
      await reader.cancel()
      reader.releaseLock()
    }),
  )
})

describe("Provider.createTimeoutFetch idle and wall watchdogs", () => {
  test(
    "records an idle fire when a stream goes quiet after its first chunk",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () =>
          new Response(oneChunkThenSilent(), { status: 200, headers: { "content-type": "text/event-stream" } }),
        noProxy: false,
        timeouts: { providerTtfbMs: 5_000, providerIdleMs: 40, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})
      const reader = response.body!.getReader()
      await reader.read()
      await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" })

      const fired = recordedRows(metrics, "llm.watchdog.fired")
      expect(fired).toHaveLength(1)
      expect(fired[0]).toMatchObject({ value: 1, unit: "count", labels: { kind: "idle" } })
    }),
  )

  test(
    "records a wall fire for a stream that keeps sending keep-alive frames",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      let sent = false
      const heartbeat = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent) {
            await Bun.sleep(20)
            return
          }
          sent = true
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        },
      })
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () => new Response(heartbeat, { status: 200, headers: { "content-type": "text/event-stream" } }),
        noProxy: false,
        // The idle watchdog cannot bound a stream that emits keep-alive frames, so
        // only the wall watchdog can end it.
        timeouts: { providerTtfbMs: 5_000, providerIdleMs: false, providerWallMs: 60 },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})
      const reader = response.body!.getReader()
      await reader.read()

      await until(() => recordedRows(metrics, "llm.watchdog.fired").length > 0)
      const fired = recordedRows(metrics, "llm.watchdog.fired")
      expect(fired).toHaveLength(1)
      expect(fired[0]).toMatchObject({ value: 1, unit: "count", labels: { kind: "wall" } })
      await reader.cancel().catch(() => {})
    }),
  )
})

describe("Provider.createTimeoutFetch TTFB is one-shot, idle covers the stream", () => {
  test(
    "is never re-armed: chunks spaced beyond the TTFB budget do not fire it",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      let sent = 0
      // One byte up front disarms TTFB; every later chunk then arrives after a
      // gap far longer than the TTFB budget. If TTFB were re-armed per chunk (the
      // behaviour a long reasoning prefill would depend on), this would abort.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 0) {
            sent++
            controller.enqueue(encoder.encode("data: 思考开始\n\n"))
            return
          }
          if (sent < 5) {
            sent++
            await Bun.sleep(120)
            controller.enqueue(encoder.encode("data: 更多思考\n\n"))
            return
          }
          controller.close()
        },
      })
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        noProxy: false,
        // TTFB budget 40ms, idle budget 500ms: the 120ms inter-chunk gaps are
        // 3x the TTFB budget but far under idle, so only a re-armed TTFB could fire.
        timeouts: { providerTtfbMs: 40, providerIdleMs: 500, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})

      await expect(drain(response.body!)).resolves.toHaveLength(5)

      expect(recordedRows(metrics, "llm.watchdog.fired")).toHaveLength(0)
      // The first byte still reports the phase boundary exactly once.
      expect(recordedRows(metrics, "llm.fetch.first_byte")).toHaveLength(1)
    }),
  )

  test(
    "the idle watchdog protects a long prefill after the first byte, not TTFB",
    runtime.bind(async () => {
      using metrics = spyOn(ObservabilityMetrics, "record")
      let sent = 0
      // Models a reasoning model that emits a keep-warm first frame and then
      // thinks for a long time. TTFB is already satisfied, so only idle applies.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent > 0) return
          sent++
          controller.enqueue(encoder.encode("data: 首帧\n\n"))
        },
      })
      const timeoutFetch = Provider.createTimeoutFetch({
        fetchFn: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        noProxy: false,
        // TTFB budget 30ms is already spent; idle 150ms is what must eventually fire.
        timeouts: { providerTtfbMs: 30, providerIdleMs: 150, providerWallMs: false },
        labels: { provider: "test-provider", model: "test-model" },
      })

      const response = await timeoutFetch("https://provider.invalid/v1/chat/completions", {})
      const reader = response.body!.getReader()
      await reader.read()
      await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" })

      const fired = recordedRows(metrics, "llm.watchdog.fired")
      expect(fired).toHaveLength(1)
      // The long silence is attributed to idle, never to TTFB.
      expect(fired[0]).toMatchObject({ unit: "count", labels: { kind: "idle" } })
    }),
  )
})

afterRuntimeTests(() => runtime.close())
