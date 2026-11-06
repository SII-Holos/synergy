import { describe, expect, test } from "bun:test"
import { ProviderStream } from "../../src/provider/stream"

const encoder = new TextEncoder()

function source(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
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

describe("ProviderStream.withIdleTimeout first-byte observation", () => {
  test("reports the first body byte once, after headers are already available", async () => {
    const idle = new AbortController()
    const observed: string[] = []
    // A body that yields nothing until the test releases it models a gateway
    // that has answered with headers and is holding the body open.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate
        controller.enqueue(encoder.encode("data: first\n\n"))
      },
    })
    const stream = ProviderStream.withIdleTimeout(input, {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 5_000,
      observer: {
        onFirstByte: () => observed.push("first_byte"),
      },
    })

    const reader = stream.getReader()
    const pending = reader.read()
    // No body byte has been produced yet, so nothing may be reported.
    await Bun.sleep(20)
    expect(observed).toEqual([])

    release()
    await pending
    expect(observed).toEqual(["first_byte"])
  })

  test("fires onFirstByte only once across multiple chunks", async () => {
    const idle = new AbortController()
    let calls = 0
    const stream = ProviderStream.withIdleTimeout(source("one", "two", "three"), {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 5_000,
      observer: { onFirstByte: () => calls++ },
    })

    await drain(stream)
    expect(calls).toBe(1)
  })

  test("does not fire onFirstByte for a body that completes without bytes", async () => {
    const idle = new AbortController()
    let calls = 0
    const settled: string[] = []
    const stream = ProviderStream.withIdleTimeout(source(), {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 5_000,
      observer: {
        onFirstByte: () => calls++,
        onSettled: () => settled.push("settled"),
      },
    })

    await drain(stream)
    expect(calls).toBe(0)
    expect(settled).toEqual(["settled"])
  })

  test("fires onFirstByte for non-SSE payloads so their TTFB watchdog can be cleared", async () => {
    const idle = new AbortController()
    let calls = 0
    const stream = ProviderStream.withIdleTimeout(source('{"json":true}'), {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 5_000,
      observer: { onFirstByte: () => calls++ },
    })

    await expect(drain(stream)).resolves.toHaveLength(1)
    expect(calls).toBe(1)
  })
})

describe("ProviderStream.withIdleTimeout idle timeout control", () => {
  test("reports the idle watchdog before aborting with a TimeoutError", async () => {
    let cancelled: unknown
    let sent = false
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return
        sent = true
        controller.enqueue(encoder.encode("data"))
      },
      cancel(reason) {
        cancelled = reason
      },
    })
    const idle = new AbortController()
    const fires: string[] = []
    const reader = ProviderStream.withIdleTimeout(input, {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 20,
      observer: { onIdleTimeout: () => fires.push("idle") },
    }).getReader()

    await reader.read()
    await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" })

    expect(fires).toEqual(["idle"])
    expect(cancelled).toMatchObject({ name: "TimeoutError" })
  })

  test("disables the idle watchdog entirely when timeoutMs is false", async () => {
    let sent = false
    const input = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) return
        sent = true
        controller.enqueue(encoder.encode("data"))
      },
    })
    const idle = new AbortController()
    let fires = 0
    const reader = ProviderStream.withIdleTimeout(input, {
      controller: idle,
      signal: idle.signal,
      timeoutMs: false,
      observer: { onIdleTimeout: () => fires++ },
    }).getReader()

    await reader.read()
    await Bun.sleep(60)
    expect(idle.signal.aborted).toBe(false)
    expect(fires).toBe(0)

    await reader.cancel()
  })

  test("settles once when the stream errors", async () => {
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("broken stream"))
      },
    })
    const idle = new AbortController()
    const settled: string[] = []
    const stream = ProviderStream.withIdleTimeout(input, {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 5_000,
      observer: { onSettled: () => settled.push("settled") },
    })

    await expect(drain(stream)).rejects.toThrow("broken stream")
    expect(settled).toEqual(["settled"])
    expect(input.locked).toBe(false)
  })
})
