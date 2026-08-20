import { describe, expect, test } from "bun:test"
import { computeForkCounts, forkReplyPreview } from "../../../src/components/session/dialog-fork-confirm-model"

const timeline = [
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant" },
  { id: "u2", role: "user" },
  { id: "a2", role: "assistant" },
  { id: "a3", role: "assistant" },
] as const

describe("fork confirm counts", () => {
  test("counts user messages and assistant replies through the target message inclusive", () => {
    expect(computeForkCounts([...timeline], "a2")).toEqual({ userMessages: 2, assistantReplies: 2 })
    expect(computeForkCounts([...timeline], "u1")).toEqual({ userMessages: 1, assistantReplies: 0 })
    expect(computeForkCounts([...timeline], "a3")).toEqual({ userMessages: 2, assistantReplies: 3 })
  })

  test("ignores system and other roles when counting", () => {
    const mixed = [
      { id: "s1", role: "system" },
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "x1", role: "tool" },
    ]
    expect(computeForkCounts(mixed, "a1")).toEqual({ userMessages: 1, assistantReplies: 1 })
  })

  test("returns zero counts when the target message is not in the timeline", () => {
    expect(computeForkCounts([...timeline], "missing")).toEqual({ userMessages: 0, assistantReplies: 0 })
  })
})

describe("fork reply preview", () => {
  test("uses the first non-system text part, trimmed and truncated", () => {
    const parts = [
      { type: "tool", name: "bash" },
      { type: "text", text: "  System preamble  ", origin: "system" },
      { type: "text", text: "  Here is the reply  ", origin: "user" },
    ]
    expect(forkReplyPreview(parts)).toBe("Here is the reply")

    const long = "x".repeat(200)
    expect(forkReplyPreview([{ type: "text", text: long, origin: "user" }])).toBe(`${"x".repeat(95)}\u2026`)
  })

  test("skips synthetic parts and returns undefined without user text", () => {
    expect(forkReplyPreview([{ type: "text", text: "hidden", synthetic: true }])).toBeUndefined()
    expect(forkReplyPreview([{ type: "text", text: "system only", origin: "system" }])).toBeUndefined()
    expect(forkReplyPreview([{ type: "text", text: "   " }])).toBeUndefined()
    expect(forkReplyPreview([])).toBeUndefined()
  })
})
