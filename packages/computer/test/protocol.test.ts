import { expect, test } from "bun:test"
import { ComputerActionSchema, ComputerCommandSchema } from "../src/index"

test("actions require an observation and cannot request foreground or replace its target", () => {
  expect(ComputerActionSchema.safeParse({ observationId: "observed", action: "type", text: "你好" }).success).toBe(true)
  expect(ComputerActionSchema.safeParse({ action: "type", text: "text" }).success).toBe(false)
  expect(
    ComputerActionSchema.safeParse({ observationId: "observed", action: "type", text: "text", pid: 4 }).success,
  ).toBe(false)
  expect(
    ComputerActionSchema.safeParse({
      observationId: "observed",
      action: "click",
      x: 4,
      y: 5,
      delivery_mode: "foreground",
    }).success,
  ).toBe(false)
})

test("commands have bounded inputs and a finite operation set", () => {
  expect(ComputerCommandSchema.safeParse({ type: "observe", pid: 42, windowId: 8 }).success).toBe(true)
  expect(ComputerCommandSchema.safeParse({ type: "observe", pid: -1, windowId: 8 }).success).toBe(false)
  expect(ComputerCommandSchema.safeParse({ type: "start_session" }).success).toBe(false)
  expect(
    ComputerActionSchema.safeParse({ observationId: "observed", action: "type", text: "x".repeat(20_001) }).success,
  ).toBe(false)
})
