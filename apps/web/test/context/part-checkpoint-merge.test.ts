import { describe, expect, test } from "bun:test"
import { mergeTextCheckpoint } from "../../src/context/part-checkpoint-merge"
import type { Part } from "@ericsanchezok/synergy-sdk/client"

type TextPart = Part & { text?: string }

const textPart = (text: string, overrides: Record<string, unknown> = {}) =>
  ({ id: "prt_1", sessionID: "ses_a", messageID: "msg_1", type: "reasoning", text, ...overrides }) as TextPart

const textOf = (part: Part) => (part as TextPart).text

describe("mergeTextCheckpoint", () => {
  test("applies an authoritative prefix truncation", () => {
    const incoming = textPart("abc")
    expect(mergeTextCheckpoint(textPart("abcdef"), incoming)).toBe(incoming)
  })

  test("keeps accumulated text when a checkpoint is a strict prefix of it", () => {
    const merged = mergeTextCheckpoint(textPart("abcdefghij"), textPart("abcdef"), true)
    expect(textOf(merged)).toBe("abcdefghij")
  })

  test("applies the checkpoint when its text is at least as long", () => {
    const merged = mergeTextCheckpoint(textPart("abcdef"), textPart("abcdefghij"), true)
    expect(textOf(merged)).toBe("abcdefghij")
  })

  test("applies a shorter checkpoint whose text diverges from the accumulated text", () => {
    const merged = mergeTextCheckpoint(textPart("abcdefghij"), textPart("abcdefX"), true)
    expect(textOf(merged)).toBe("abcdefX")
  })

  test("adopts checkpoint metadata while preserving accumulated text", () => {
    const merged = mergeTextCheckpoint(textPart("abcdefghij"), textPart("abcdef", { time: { start: 5 } }), true)
    expect(textOf(merged)).toBe("abcdefghij")
    expect((merged as unknown as { time: { start: number } }).time.start).toBe(5)
  })

  test("applies checkpoints verbatim for non-text parts", () => {
    const current = { id: "p", type: "tool", state: { status: "running" } } as Part
    const incoming = { id: "p", type: "tool", state: { status: "completed" } } as Part
    expect(mergeTextCheckpoint(current, incoming)).toBe(incoming)
  })

  test("applies the incoming part when the current bucket entry is a different type", () => {
    const merged = mergeTextCheckpoint({ id: "p", type: "tool" } as Part, textPart("abc"))
    expect(textOf(merged)).toBe("abc")
  })
})
