import { describe, expect, test } from "bun:test"
import { AgentStreamEventCoalescer } from "../../src/session/agent-turn/stream-event-coalescer"

type StreamEvent =
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "text-delta"; id: string; text: string; providerMetadata?: unknown }

describe("AgentStreamEventCoalescer", () => {
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
