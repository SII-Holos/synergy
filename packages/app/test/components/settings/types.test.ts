import { describe, expect, test } from "bun:test"
import { TOAST_DURATION_STOPS, defaultSettingsState, snapToastDuration } from "../../../src/components/settings/types"

describe("settings types", () => {
  test("snaps toast durations to the discrete settings stops", () => {
    expect([...TOAST_DURATION_STOPS]).toEqual([1000, 2000, 4000, 8000])
    expect(snapToastDuration(3000)).toBe(4000)
    expect(snapToastDuration(5000)).toBe(4000)
    expect(snapToastDuration(7000)).toBe(8000)
    expect(snapToastDuration(0)).toBe(4000)
  })

  test("defaults Cortex concurrency to the stable runtime limit", () => {
    expect(defaultSettingsState("enter").runtime.cortexConcurrency).toBe("8")
  })
})
