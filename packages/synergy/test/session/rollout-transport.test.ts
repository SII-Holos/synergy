import { describe, expect, test } from "bun:test"
import { RolloutTransport } from "../../src/session/rollout/transport"

describe("rollout transport", () => {
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
