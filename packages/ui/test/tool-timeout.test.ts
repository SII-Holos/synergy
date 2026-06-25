import { describe, expect, test } from "bun:test"
import { toolCountdown } from "../src/components/tool/timeout"

describe("tool timeout helper", () => {
  test("uses only metadata.toolTimeout.displayMs", () => {
    expect(toolCountdown({ timeout: 10 }, { start: 1_000 })).toBeUndefined()
    expect(toolCountdown({ toolTimeout: { displayMs: 15_000 } }, { start: 1_000 })).toEqual({
      seconds: 15,
      startedAt: 1_000,
    })
  })

  test("keeps countdown anchored to tool start time", () => {
    const result = toolCountdown({ toolTimeout: { displayMs: 300_000 } }, { start: 123_456 })
    expect(result).toEqual({ seconds: 300, startedAt: 123_456 })
  })

  test("does not show countdown without a valid display timeout", () => {
    expect(toolCountdown({}, { start: 1 })).toBeUndefined()
    expect(toolCountdown({ toolTimeout: { displayMs: 0 } }, { start: 1 })).toBeUndefined()
    expect(toolCountdown({ toolTimeout: { displayMs: "300000" } }, { start: 1 })).toBeUndefined()
  })
})
