import { describe, expect, test } from "bun:test"
import { ProviderStream } from "../../src/provider/stream"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function source(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function read(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let output = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) return output
    output += decoder.decode(value, { stream: true })
  }
}

describe("ProviderStream.enforceSSEEventParserBound", () => {
  test("passes bounded events and recognizes delimiters split across chunks", async () => {
    const input = ["data: first\r", "\n\r", "\ndata: second\n", "\n"]
    const output = await read(ProviderStream.enforceSSEEventParserBound(source(...input), 32))
    expect(output).toBe(input.join(""))
  })

  test("accepts consecutive CRLF events at the exact parser bound", async () => {
    const maxBytes = 32
    const event = `data: ${"x".repeat(maxBytes - "data: ".length - 2)}\r\n\r\n`
    const input = event.repeat(2)

    await expect(read(ProviderStream.enforceSSEEventParserBound(source(input), maxBytes))).resolves.toBe(input)
  })

  test("terminates an unterminated event at the byte limit", async () => {
    const stream = ProviderStream.enforceSSEEventParserBound(source("data: ", "x".repeat(33)), 32)
    await expect(read(stream)).rejects.toThrow("SSE event parser bound of 32 bytes exceeded")
  })
})

describe("ProviderStream.withIdleTimeout", () => {
  test("releases the upstream reader after normal completion", async () => {
    const input = source("data")
    const idle = new AbortController()

    await expect(
      read(
        ProviderStream.withIdleTimeout(input, {
          controller: idle,
          signal: idle.signal,
          timeoutMs: 100,
        }),
      ),
    ).resolves.toBe("data")
    expect(input.locked).toBe(false)
  })

  test("does not retain completed read chunks linearly through abort waiters", async () => {
    const consume = async () => {
      const refs: WeakRef<Uint8Array>[] = []
      let sent = 0
      const input = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ >= 64) {
            controller.close()
            return
          }
          const chunk = new Uint8Array(64 * 1024)
          refs.push(new WeakRef(chunk))
          controller.enqueue(chunk)
        },
      })
      const idle = new AbortController()
      const reader = ProviderStream.withIdleTimeout(input, {
        controller: idle,
        signal: idle.signal,
        timeoutMs: 100,
      }).getReader()

      while (!(await reader.read()).done) {}
      return { reader, refs }
    }

    const state = await consume()
    await Bun.sleep(0)
    Bun.gc(true)
    await Bun.sleep(0)
    Bun.gc(true)

    const retained = state.refs.filter((ref) => ref.deref() !== undefined).length
    expect(retained).toBeLessThan(state.refs.length / 4)
    await expect(state.reader.closed).resolves.toBeUndefined()
  })

  test("cancels and releases the upstream reader after downstream cancellation", async () => {
    let cancelled: unknown
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data"))
      },
      cancel(reason) {
        cancelled = reason
      },
    })
    const idle = new AbortController()
    const reader = ProviderStream.withIdleTimeout(input, {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 100,
    }).getReader()

    await reader.read()
    await reader.cancel("stop")

    expect(cancelled).toBe("stop")
    expect(input.locked).toBe(false)
  })

  test("cancels and releases the upstream reader after an upstream error", async () => {
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("broken stream"))
      },
    })
    const idle = new AbortController()

    await expect(
      read(
        ProviderStream.withIdleTimeout(input, {
          controller: idle,
          signal: idle.signal,
          timeoutMs: 100,
        }),
      ),
    ).rejects.toThrow("broken stream")
    expect(input.locked).toBe(false)
  })

  test("cancels and releases the upstream reader after an idle timeout", async () => {
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
    const reader = ProviderStream.withIdleTimeout(input, {
      controller: idle,
      signal: idle.signal,
      timeoutMs: 20,
    }).getReader()

    await reader.read()
    await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" })

    expect(cancelled).toMatchObject({ name: "TimeoutError" })
    expect(input.locked).toBe(false)
  })
})
