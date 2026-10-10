import { describe, expect, test } from "bun:test"
import { AgentStreamEventCoalescer } from "../../src/session/agent-turn/stream-event-coalescer"

type StreamEvent =
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "text-delta"; id: string; text: string; providerMetadata?: unknown }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-end"; id: string }

describe("AgentStreamEventCoalescer", () => {
  test.each(["text-delta", "reasoning-delta", "tool-input-delta"] as const)(
    "delivers a held %s before the producer resumes",
    async (type) => {
      const resume = Promise.withResolvers<void>()
      const event: StreamEvent =
        type === "tool-input-delta"
          ? { type, id: "call_held", delta: '{"ui":{"nodes":[' }
          : { type, id: "call_held", text: "visible prefix" }
      const end: StreamEvent = {
        type: type === "tool-input-delta" ? "tool-input-end" : type === "text-delta" ? "text-end" : "reasoning-end",
        id: "call_held",
      }
      const source = (async function* () {
        yield event
        await resume.promise
        yield end
      })()
      const batches = new AgentStreamEventCoalescer<StreamEvent>().batches(source)
      const first = batches.next()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const delivered = await Promise.race([
          first,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 750)
          }),
        ])
        expect(delivered).toEqual({ done: false, value: [event] })
        resume.resolve()
        expect(await batches.next()).toEqual({ done: false, value: [end] })
        expect((await batches.next()).done).toBe(true)
      } finally {
        clearTimeout(timer)
        resume.resolve()
        await first
        await batches.return(undefined)
      }
    },
  )

  test("keeps one pending read under backpressure and closes the producer on cancellation", async () => {
    const pending = Promise.withResolvers<IteratorResult<StreamEvent>>()
    const event: StreamEvent = { type: "text-delta", id: "text_1", text: "visible" }
    let reads = 0
    let returns = 0
    const source: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            reads++
            return reads === 1 ? Promise.resolve({ done: false as const, value: event }) : pending.promise
          },
          async return() {
            returns++
            return { done: true, value: undefined }
          },
        }
      },
    }
    const coalescer = new AgentStreamEventCoalescer<StreamEvent>()
    const batches = coalescer.batches(source)
    try {
      expect(await batches.next()).toEqual({ done: false, value: [event] })
      await Bun.sleep(32)
      expect(reads).toBe(2)
      await batches.return(undefined)
      expect(returns).toBe(1)
      pending.resolve({ done: false, value: { ...event, text: "late" } })
      expect((await batches.next()).done).toBe(true)
      expect(coalescer.flush()).toEqual([])
    } finally {
      pending.resolve({ done: true, value: undefined })
      await batches.return(undefined)
    }
  })

  test("preserves an upstream failure when producer cleanup also fails", async () => {
    const failure = new Error("provider failed")
    const source: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(failure),
          return: () => Promise.reject(new Error("cleanup failed")),
        }
      },
    }
    await expect(new AgentStreamEventCoalescer<StreamEvent>().batches(source).next()).rejects.toBe(failure)
  })

  test("flushes the final delta at normal end without waiting for another event", async () => {
    const event: StreamEvent = { type: "text-delta", id: "text_1", text: "complete" }
    const source = (async function* () {
      yield event
    })()
    const emitted: StreamEvent[] = []
    for await (const batch of new AgentStreamEventCoalescer<StreamEvent>().batches(source)) emitted.push(...batch)
    expect(emitted).toEqual([event])
  })

  test("coalesces thousands of tool-input deltas for one call into one bounded frame", () => {
    const coalescer = new AgentStreamEventCoalescer<StreamEvent>()
    const frames: StreamEvent[][] = []
    const push = (event: StreamEvent) => {
      const frame = coalescer.push(event, 0)
      if (frame.length > 0) frames.push(frame)
    }

    push({ type: "tool-input-start", id: "call_render", toolName: "render" })
    for (let index = 0; index < 4_702; index++) {
      push({ type: "tool-input-delta", id: "call_render", delta: index % 2 === 0 ? "<" : "div>" })
    }
    push({ type: "tool-input-end", id: "call_render" })

    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual([{ type: "tool-input-start", id: "call_render", toolName: "render" }])
    expect(frames[1]).toEqual([
      {
        type: "tool-input-delta",
        id: "call_render",
        delta: Array.from({ length: 4_702 }, (_, index) => (index % 2 === 0 ? "<" : "div>")).join(""),
      },
      { type: "tool-input-end", id: "call_render" },
    ])
  })

  test("preserves event order when tool-input call IDs interleave", () => {
    const coalescer = new AgentStreamEventCoalescer<StreamEvent>()
    const emitted = [
      ...coalescer.push({ type: "tool-input-delta", id: "call_a", delta: "a1" }, 0),
      ...coalescer.push({ type: "tool-input-delta", id: "call_b", delta: "b1" }, 0),
      ...coalescer.push({ type: "tool-input-delta", id: "call_a", delta: "a2" }, 0),
      ...coalescer.flush(),
    ]

    expect(emitted).toEqual([
      { type: "tool-input-delta", id: "call_a", delta: "a1" },
      { type: "tool-input-delta", id: "call_b", delta: "b1" },
      { type: "tool-input-delta", id: "call_a", delta: "a2" },
    ])
  })

  test("flushes long tool input in chunks no larger than 32 KiB", () => {
    const coalescer = new AgentStreamEventCoalescer<StreamEvent>()
    const emitted: StreamEvent[] = []
    for (let index = 0; index < 70_000; index++) {
      emitted.push(...coalescer.push({ type: "tool-input-delta", id: "call_large", delta: "x" }, 0))
    }
    emitted.push(...coalescer.flush())

    const deltas = emitted.filter(
      (event): event is Extract<StreamEvent, { type: "tool-input-delta" }> => event.type === "tool-input-delta",
    )
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.every((event) => event.delta.length <= 32 * 1024)).toBe(true)
    expect(deltas.map((event) => event.delta).join("")).toBe("x".repeat(70_000))
  })

  test("keeps text coalescing time-bounded and retains the first delta metadata", () => {
    const coalescer = new AgentStreamEventCoalescer<StreamEvent>()
    const emitted = [
      ...coalescer.push(
        { type: "text-delta", id: "text_1", text: "hello", providerMetadata: { provider: { item: 1 } } },
        0,
      ),
      ...coalescer.push({ type: "text-delta", id: "text_1", text: " world" }, 15),
      ...coalescer.push({ type: "text-delta", id: "text_1", text: "!" }, 16),
      ...coalescer.flush(),
    ]

    expect(emitted).toEqual([
      {
        type: "text-delta",
        id: "text_1",
        text: "hello world",
        providerMetadata: { provider: { item: 1 } },
      },
      { type: "text-delta", id: "text_1", text: "!" },
    ])
  })
})
