import { describe, expect, test } from "bun:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { extractReasoningMiddleware } from "ai"
import { reasoningStreamGuardMiddleware } from "../../src/session/reasoning-stream-guard"

function stream(parts: LanguageModelV4StreamPart[]) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function collect(input: ReadableStream<LanguageModelV4StreamPart>) {
  const result: LanguageModelV4StreamPart[] = []
  const reader = input.getReader()
  while (true) {
    const item = await reader.read()
    if (item.done) break
    result.push(item.value)
  }
  return result
}

async function applyMiddleware(
  middleware: ReturnType<typeof reasoningStreamGuardMiddleware> | ReturnType<typeof extractReasoningMiddleware>,
  input: ReadableStream<LanguageModelV4StreamPart>,
) {
  const wrapped = await middleware.wrapStream!({
    doStream: async () => ({ stream: input }),
    doGenerate: async () => {
      throw new Error("not used")
    },
    params: {} as never,
    model: {} as never,
  })
  return wrapped.stream
}

describe("reasoningStreamGuardMiddleware", () => {
  test("preserves balanced reasoning around an empty think block", async () => {
    const extracted = await applyMiddleware(
      extractReasoningMiddleware({ tagName: "think", startWithReasoning: false }),
      stream([
        { type: "text-start", id: "txt-0" },
        { type: "text-delta", id: "txt-0", delta: "<think></think>summary" },
        { type: "text-end", id: "txt-0" },
      ]),
    )
    const guarded = await applyMiddleware(reasoningStreamGuardMiddleware(), extracted)
    const parts = await collect(guarded)

    const active = new Set<string>()
    for (const part of parts) {
      if (part.type === "reasoning-start") active.add(part.id)
      if (part.type === "reasoning-end") expect(active.delete(part.id)).toBe(true)
    }
    expect(active.size).toBe(0)
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", id: "txt-0", delta: "summary" },
    ])
  })

  test("synthesizes a start before an orphan reasoning delta", async () => {
    const guarded = await applyMiddleware(
      reasoningStreamGuardMiddleware(),
      stream([
        { type: "reasoning-delta", id: "reasoning-0", delta: "analysis" },
        { type: "reasoning-end", id: "reasoning-0" },
      ]),
    )

    expect(await collect(guarded)).toEqual([
      { type: "reasoning-start", id: "reasoning-0" },
      { type: "reasoning-delta", id: "reasoning-0", delta: "analysis" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })
})
