import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { fn } from "../src/fn"

describe("fn", () => {
  const schema = z.object({ value: z.number().positive() })
  const double = fn(schema, (input) => input.value * 2)

  test("parses input through the schema before invoking the callback", () => {
    expect(double({ value: 21 })).toBe(42)
    expect(() => double({ value: -1 })).toThrow(z.ZodError)
    expect(() => double({ value: "x" as never })).toThrow(z.ZodError)
  })

  test("exposes the schema on the wrapper", () => {
    expect(double.schema).toBe(schema)
  })

  test("force bypasses schema parsing", () => {
    expect(double.force({ value: -5 })).toBe(-10)
  })
})
