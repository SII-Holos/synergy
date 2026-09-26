import { afterAll, describe, expect, test } from "bun:test"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"

import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())

test.each(["network-failure", "empty-response", "stream-response"] as const)(
  "settles a locked upload before %s ends the attempt",
  (mode) =>
    runtime.run(async () => {
      const id = crypto.randomUUID()
      const call = await RolloutLedger.beginCall({
        owner: { kind: "operation", scopeID: "test", operationID: id },
        runID: id,
        purpose: "test",
        model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
        request: {},
      })
      const recorder = RolloutTransportRecorder.create(call)
      const events: RolloutTransport.Event[] = []
      const request = new Request("https://fixture.test", { method: "POST", body: "a".repeat(350000) }).clone()
      const failure = new Error("connection reset during upload")
      let upload: Promise<unknown> | undefined
      let uploadReader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const result = await RolloutTransport.provide(
        async (event) => {
          events.push(event)
          await recorder.emit(event)
        },
        () =>
          RolloutTransport.fetch(async (input) => {
            const reader = (input as Request).body!.getReader()
            uploadReader = reader
            await reader.read()
            upload = reader.read().then(
              () => undefined,
              (error: unknown) => error,
            )
            if (mode === "network-failure") throw failure
            return mode === "empty-response" ? new Response(null, { status: 204 }) : new Response("done")
          }, request),
      )
        .then((response) => response.text())
        .catch((error: unknown) => error)
      const uploadResult = await upload
      uploadReader?.releaseLock()
      const recording = await recorder.finish().catch((error: unknown) => error)
      expect(result).toBe(mode === "network-failure" ? failure : mode === "empty-response" ? "" : "done")
      expect(uploadResult === undefined || uploadResult === failure || uploadResult instanceof DOMException).toBe(true)
      expect(recording).toBe(false)
      expect(events.at(-1)).toMatchObject({
        type: "attempt-end",
        status: mode === "network-failure" ? "failed" : "completed",
      })
      expect(events.filter((event) => event.type === "body-end" && event.channel === "request")).toHaveLength(1)
    }),
)

test.each(["failure", "early-response"] as const)(
  "finishes a cloned upload after %s without waiting for its live sibling",
  async (mode) => {
    const events: RolloutTransport.Event[] = []
    let producer!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        producer = controller
      },
    })
    const original = new Request("https://fixture.test", { method: "POST", body: source })
    const request = original.clone()
    const failure = new Error("upload disconnected")
    let uploadReader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let upload: Promise<unknown> | undefined
    try {
      const result = await RolloutTransport.provide(
        async (event) => {
          events.push(event)
        },
        () =>
          RolloutTransport.fetch(async (input) => {
            uploadReader = (input as Request).body!.getReader()
            upload = uploadReader.read().catch((error: unknown) => error)
            if (mode === "failure") throw failure
            return new Response(null, { status: 204 })
          }, request),
      )
        .then((response) => response.text())
        .catch((error: unknown) => error)
      expect(result).toBe(mode === "failure" ? failure : "")
      expect(await upload).toEqual(mode === "failure" ? failure : expect.any(DOMException))
      expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: mode === "failure" ? "failed" : "completed" })
      producer.enqueue(new TextEncoder().encode("sibling is still usable"))
      producer.close()
      expect(await original.text()).toBe("sibling is still usable")
    } finally {
      uploadReader?.releaseLock()
      if (!original.bodyUsed) await original.body?.cancel()
    }
  },
  5000,
)

test.each(["failure", "early-response"] as const)("request cancellation failure preserves %s", async (mode) => {
  const events: RolloutTransport.Event[] = []
  const failure = new Error("upload disconnected")
  const request = new Request("https://fixture.test", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("upload cleanup failed")
      },
    }),
  })
  const result = await RolloutTransport.provide(
    async (event) => {
      events.push(event)
    },
    () =>
      RolloutTransport.fetch(async () => {
        if (mode === "failure") throw failure
        return new Response(null, { status: 204 })
      }, request),
  )
    .then((response) => response.text())
    .catch((error: unknown) => error)
  expect(result).toBe(mode === "failure" ? failure : "")
  expect(events.filter((event) => event.type === "body-end" && event.channel === "request")).toEqual([
    expect.objectContaining({ complete: false }),
  ])
  expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: mode === "failure" ? "failed" : "completed" })
})

describe("rollout transport", () => {
  test("records a buffered POST while retaining its content length through a real proxy", async () => {
    const payload = JSON.stringify({ messages: [{ role: "user", content: "read".repeat(50000) }] })
    const observed: { bytes?: string; length?: string | null; transfer?: string | null } = {}
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        observed.length = request.headers.get("content-length")
        observed.transfer = request.headers.get("transfer-encoding")
        observed.bytes = await request.text()
        return new Response("data: done\n\n", { headers: { "content-type": "text/event-stream" } })
      },
    })
    const events: RolloutTransport.Event[] = []
    const options = {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
      proxy: proxy.url.toString(),
      signal: AbortSignal.timeout(2000),
    }
    try {
      const response = await RolloutTransport.provide(
        async (event) => {
          events.push(event)
        },
        () => RolloutTransport.fetch(fetch, "http://fixture.invalid/v1/chat/completions", options),
      )
      expect(await response.text()).toBe("data: done\n\n")
      expect(observed.bytes).toBe(payload)
      expect(observed.length).toBe(String(Buffer.byteLength(payload)))
      expect(observed.transfer).toBeNull()
      const chunks = events.flatMap((event) =>
        event.type === "chunk" && event.channel === "request" ? [event.data] : [],
      )
      expect(Buffer.concat(chunks).toString()).toBe(payload)
      expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "completed" })
    } finally {
      proxy.stop(true)
    }
  })

  test("keeps request options on the Request and forwards transport-only options", async () => {
    const options = {
      method: "POST",
      body: "hello",
      headers: { "x-test": "value" },
      proxy: "http://proxy.test",
      timeout: false,
    }
    await RolloutTransport.provide(
      async () => {},
      async () => {
        const response = await RolloutTransport.fetch(
          async (input, init) => {
            expect(input).toBeInstanceOf(Request)
            const request = input as Request
            expect(request.method).toBe("POST")
            expect(request.headers.get("x-test")).toBe("value")
            expect(await request.text()).toBe("hello")
            expect(Object.fromEntries(Object.entries(init ?? {}))).toEqual({
              proxy: "http://proxy.test",
              timeout: false,
            })
            return new Response("done")
          },
          "https://example.test",
          options,
        )
        await response.text()
      },
    )
  })

  test("preserves bytes received before an upstream failure inside a batch", async () => {
    const events: RolloutTransport.Event[] = []
    let sent = false
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) {
            controller.error(new Error("connection lost"))
            return
          }
          sent = true
          controller.enqueue(new TextEncoder().encode("valid prefix"))
        },
      },
      { highWaterMark: 0 },
    )
    await expect(
      RolloutTransport.provide(
        async (event) => {
          events.push(event)
        },
        async () => (await RolloutTransport.fetch(async () => new Response(source), "https://example.test")).text(),
      ),
    ).rejects.toThrow("connection lost")
    const chunks = events.flatMap((event) => (event.type === "chunk" ? [event.data] : []))
    expect(Buffer.concat(chunks).toString()).toBe("valid prefix")
    expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "failed" })
  })

  test("batches small network chunks without changing the response bytes", async () => {
    const events: RolloutTransport.Event[] = []
    let sent = 0
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent++ === 100) {
            controller.close()
            return
          }
          controller.enqueue(new TextEncoder().encode("hello"))
        },
      },
      { highWaterMark: 0 },
    )
    const result = await RolloutTransport.provide(
      async (event) => {
        events.push(event)
      },
      async () => (await RolloutTransport.fetch(async () => new Response(source), "https://example.test")).text(),
    )
    expect(result).toBe("hello".repeat(100))
    expect(events.filter((event) => event.type === "chunk").length).toBeLessThan(10)
  })

  test("cancels the response if its metadata cannot be committed", async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    await expect(
      RolloutTransport.provide(
        async (event) => {
          if (event.type === "response") throw new Error("disk full")
        },
        () => RolloutTransport.fetch(async () => new Response(source), "https://example.test"),
      ),
    ).rejects.toMatchObject({ name: "RolloutRecordingError" })
    expect(cancelled).toBe(true)
    expect(source.locked).toBe(false)
  })

  test("keeps a cancelled response prefix and releases the upstream reader", async () => {
    const events: RolloutTransport.Event[] = []
    const source = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new TextEncoder().encode("prefix"))
        },
      },
      { highWaterMark: 0 },
    )
    await RolloutTransport.provide(
      async (event) => {
        events.push(event)
      },
      async () => {
        const response = await RolloutTransport.fetch(async () => new Response(source), "https://example.test")
        const reader = response.body!.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("prefix")
        await reader.cancel()
        reader.releaseLock()
      },
    )
    expect(source.locked).toBe(false)
    expect(events.at(-2)).toMatchObject({ type: "body-end", channel: "response", complete: false })
    expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "cancelled" })
  })

  test("captures the exact sent body and consumed response without credentials", async () => {
    const events: RolloutTransport.Event[] = []
    const body = JSON.stringify({ model: "test", input: [{ role: "user", content: "你好" }] })
    const result = await RolloutTransport.provide(
      async (event) => {
        events.push(event)
      },
      async () => {
        const response = await RolloutTransport.fetch(
          async (request) => {
            expect(await new Request(request).text()).toBe(body)
            return new Response("data: hello\n\ndata: done\n\n", {
              headers: { "content-type": "text/event-stream", "x-request-id": "req-1", "set-cookie": "private" },
            })
          },
          "https://example.test/responses?api_key=private",
          {
            method: "POST",
            body,
            headers: { authorization: "Bearer private", "content-type": "application/json" },
          },
        )
        return response.text()
      },
    )
    expect(result).toBe("data: hello\n\ndata: done\n\n")
    const bytes = (channel: string) =>
      Buffer.concat(
        events.flatMap((event) => (event.type === "chunk" && event.channel === channel ? [event.data] : [])),
      ).toString()
    expect(bytes("request")).toBe(body)
    expect(bytes("response")).toBe(result)
    expect(events[0]).toMatchObject({ type: "attempt-start", url: "https://example.test/responses", method: "POST" })
    expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "completed" })
    expect(JSON.stringify(events)).not.toContain("private")
  })

  test("awaits persistence before forwarding bytes and cancels on recording failure", async () => {
    let produced = 0
    let cancelled = false
    let stream: ReadableStream<Uint8Array> | undefined
    await expect(
      RolloutTransport.provide(
        async (event) => {
          if (event.type === "chunk") throw new Error("disk full")
        },
        async () => {
          stream = new ReadableStream(
            {
              pull(controller) {
                produced++
                controller.enqueue(new Uint8Array(256))
              },
              cancel() {
                cancelled = true
              },
            },
            { highWaterMark: 0 },
          )
          const response = await RolloutTransport.fetch(async () => new Response(stream), "https://example.test")
          await response.text()
        },
      ),
    ).rejects.toMatchObject({ name: "RolloutRecordingError" })
    expect(produced).toBeLessThanOrEqual(1024)
    expect(cancelled).toBe(true)
    expect(stream!.locked).toBe(false)
  })

  test("separates attempts and isolates concurrent recording contexts", async () => {
    const results = await Promise.all(
      ["a", "b"].map(async (value) => {
        const events: RolloutTransport.Event[] = []
        await RolloutTransport.provide(
          async (event) => {
            events.push(event)
          },
          async () => {
            for (let index = 0; index < 2; index++) {
              const response = await RolloutTransport.fetch(async () => new Response(value), "https://example.test")
              await response.text()
            }
          },
        )
        expect(new Set(events.map((event) => event.attemptID)).size).toBe(2)
        return events.filter((event) => event.type === "chunk").map((event) => new TextDecoder().decode(event.data))
      }),
    )
    expect(results).toEqual([
      ["a", "a"],
      ["b", "b"],
    ])
  })
})

describe("rollout cancellation barriers", () => {
  test("drains a received prefix before closing a body with a pending upstream read", async () => {
    const waiting = Promise.withResolvers<void>()
    const events: RolloutTransport.Event[] = []
    let bodyClosed = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("retained prefix"))
      },
      pull() {
        waiting.resolve()
      },
    })
    const response = await RolloutTransport.provide(
      async (event) => {
        if (event.type === "body-end" && event.channel === "response") bodyClosed = true
        if (event.type === "chunk" && bodyClosed) throw new Error("write after body-end")
        events.push(event)
      },
      () => RolloutTransport.fetch(async () => new Response(source), "https://example.test"),
    )
    const reader = response.body!.getReader()
    const reading = reader.read()
    await waiting.promise
    await Promise.all([reader.cancel(), reading])
    const chunks = events.filter((event) => event.type === "chunk")
    expect(chunks.map((event) => new TextDecoder().decode(event.data)).join("")).toBe("retained prefix")
    expect(events.slice(-2)).toMatchObject([
      { type: "body-end", channel: "response", complete: false },
      { type: "attempt-end", status: "cancelled" },
    ])
    expect(source.locked).toBe(false)
    reader.releaseLock()
  })

  test("cancellation waits for an admitted chunk write before ending the attempt", async () => {
    const writing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const events: RolloutTransport.Event[] = []
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024))
      },
      cancel() {
        cancelled.resolve()
      },
    })
    const response = await RolloutTransport.provide(
      async (event) => {
        if (event.type === "chunk") {
          writing.resolve()
          await release.promise
        }
        events.push(event)
      },
      () => RolloutTransport.fetch(async () => new Response(source), "https://example.test"),
    )
    const reader = response.body!.getReader()
    const reading = reader.read()
    await writing.promise
    const cancelling = reader.cancel()
    try {
      await cancelled.promise
      await Promise.resolve()
      expect(events.some((event) => event.type === "attempt-end")).toBe(false)
      expect(events.some((event) => event.type === "body-end" && event.channel === "response")).toBe(false)
    } finally {
      release.resolve()
      await Promise.all([cancelling, reading])
      reader.releaseLock()
    }
    expect(events.slice(-2)).toMatchObject([
      { type: "body-end", channel: "response", complete: false },
      { type: "attempt-end", status: "cancelled" },
    ])
  })
})

test("joins an aborted upstream reader before closing its buffered response", async () => {
  const waiting = Promise.withResolvers<void>()
  let upstream: ReadableStreamDefaultController<Uint8Array>
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller
      controller.enqueue(new TextEncoder().encode("before abort"))
    },
    pull() {
      waiting.resolve()
    },
  })
  const events: RolloutTransport.Event[] = []
  const response = await RolloutTransport.provide(
    async (event) => {
      events.push(event)
    },
    () => RolloutTransport.fetch(async () => new Response(source), "https://fixture.test"),
  )
  const reader = response.body!.getReader()
  const reading = reader.read()
  await waiting.promise
  upstream!.error(new DOMException("aborted", "AbortError"))
  await Promise.all([reader.cancel(), reading])
  expect(
    events
      .filter((event) => event.type === "chunk")
      .map((event) => new TextDecoder().decode(event.data))
      .join(""),
  ).toBe("before abort")
  expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "cancelled" })
  expect(source.locked).toBe(false)
  reader.releaseLock()
})

test("an upstream abort cannot discard an already received oversized chunk tail", async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  const bytes = new Uint8Array(2 * 1024 * 1024).fill(37)
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller
      controller.enqueue(bytes)
    },
  })
  const events: RolloutTransport.Event[] = []
  const response = await RolloutTransport.provide(
    async (event) => {
      events.push(event)
    },
    () => RolloutTransport.fetch(async () => new Response(source), "https://fixture.test"),
  )
  const reader = response.body!.getReader()
  await reader.read()
  const failure = new DOMException("aborted after admitted read", "AbortError")
  upstream.error(failure)
  await reader.cancel(failure)
  expect(
    events.filter((event) => event.type === "chunk").reduce((size, event) => size + event.data.byteLength, 0),
  ).toBe(bytes.byteLength)
  expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "cancelled" })
  expect(source.locked).toBe(false)
  reader.releaseLock()
})

test("cancellation joins an admitted body-end without writing or finishing twice", async () => {
  const ending = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: RolloutTransport.Event[] = []
  const response = await RolloutTransport.provide(
    async (event) => {
      if (event.type === "body-end" && event.channel === "response") {
        ending.resolve()
        await release.promise
      }
      events.push(event)
    },
    () => RolloutTransport.fetch(async () => new Response("body"), "https://fixture.test"),
  )
  const reader = response.body!.getReader()
  await reader.read()
  const reading = reader.read()
  await ending.promise
  let closed = false
  const closing = reader.cancel().then(() => {
    closed = true
  })
  try {
    await Promise.resolve()
    expect(closed).toBe(false)
  } finally {
    release.resolve()
    await Promise.all([closing, reading])
    reader.releaseLock()
  }
  expect(events.filter((event) => event.type === "body-end" && event.channel === "response")).toHaveLength(1)
  expect(events.filter((event) => event.type === "attempt-end")).toHaveLength(1)
  expect(events.at(-1)?.type).toBe("attempt-end")
})
