import { expect, test } from "bun:test"
import { ComputerActionSchema, ComputerObserveSchema, ComputerHostMessageSchema } from "../src/index"

test("one target form covers clicks and directed text without legacy point commands", () => {
  const observationId = "observation"
  for (const target of [{ elementIndex: 3 }, { x: 20, y: 30 }]) {
    expect(ComputerActionSchema.safeParse({ observationId, action: "click", target, foreground: true }).success).toBe(
      true,
    )
    expect(ComputerActionSchema.safeParse({ observationId, action: "type", target, text: "你好" }).success).toBe(true)
  }
  expect(ComputerActionSchema.safeParse({ observationId, action: "point", x: 20, y: 30 }).success).toBe(false)
  expect(
    ComputerActionSchema.safeParse({ observationId, action: "click", target: { elementIndex: 3, x: 20, y: 30 } })
      .success,
  ).toBe(false)
  expect(
    ComputerActionSchema.safeParse({ observationId, action: "set_value", target: { x: 20, y: 30 }, value: "x" })
      .success,
  ).toBe(false)
})

test("foreground observation is explicit and previous hosts cannot attach", () => {
  expect(ComputerObserveSchema.parse({ pid: 1, windowId: 2, foreground: true }).foreground).toBe(true)
  expect(ComputerObserveSchema.parse({ pid: 1, windowId: 2 }).foreground).toBeUndefined()
  expect(ComputerHostMessageSchema.safeParse({ type: "register", version: 2, token: "a".repeat(64) }).success).toBe(
    false,
  )
})
