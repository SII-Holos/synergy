import { describe, expect, test } from "bun:test"
import z from "zod"
import { SessionToolInput } from "../../src/session/tool-input"

const recordSchema = z.record(z.string(), z.any())

describe("SessionToolInput.normalize", () => {
  test("parses stringified JSON object tool input into a record", () => {
    const input = SessionToolInput.normalize(
      JSON.stringify({
        id: "note_123",
        ops: [{ index: 1, action: "insertAfter", content: "Updated focus area" }],
      }),
    )

    expect(input).toEqual({
      id: "note_123",
      ops: [{ index: 1, action: "insertAfter", content: "Updated focus area" }],
    })
    expect(() => recordSchema.parse(input)).not.toThrow()
  })

  test("wraps non-record tool input without violating the tool part schema", () => {
    expect(SessionToolInput.normalize("not json")).toEqual({ raw: "not json" })
    expect(SessionToolInput.normalize("[1,2]")).toEqual({ raw: "[1,2]" })
    expect(SessionToolInput.normalize(42)).toEqual({ value: 42 })
    expect(SessionToolInput.normalize(undefined)).toEqual({})
  })
})
