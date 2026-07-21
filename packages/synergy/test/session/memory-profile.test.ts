import { beforeEach, describe, expect, test } from "bun:test"
import { SessionMemoryProfile } from "../../src/session/memory-profile"
import type { SessionMemoryPressure } from "../../src/session/memory-pressure"

const pressured: SessionMemoryPressure.Snapshot = {
  rssBytes: 2_000,
  heapUsedBytes: 1_500,
  heapTotalBytes: 1_000,
  externalBytes: 700,
  arrayBuffersBytes: 500,
}

describe("SessionMemoryProfile", () => {
  beforeEach(() => SessionMemoryProfile.resetForTest())

  test("captures once at soft pressure in a local development runtime", async () => {
    const captured: string[] = []
    SessionMemoryProfile.setCaptureForTest(async (reason) => {
      captured.push(reason)
      return { bytes: 123 }
    })

    const first = await SessionMemoryProfile.maybeCapture({
      reason: "llm.stream.periodic",
      snapshot: pressured,
      soft: true,
      development: true,
      now: 10_000,
    })
    const second = await SessionMemoryProfile.maybeCapture({
      reason: "llm.stream.periodic",
      snapshot: pressured,
      soft: true,
      development: true,
      now: 10_001,
    })

    expect(first).toMatchObject({ action: "captured", bytes: 123 })
    expect(second.action).toBe("skipped_cooldown")
    expect(captured).toEqual(["llm.stream.periodic"])
  })

  test("does not capture outside development mode or below soft pressure", async () => {
    expect(
      (
        await SessionMemoryProfile.maybeCapture({
          reason: "test",
          snapshot: pressured,
          soft: true,
          development: false,
        })
      ).action,
    ).toBe("disabled")
    expect(
      (
        await SessionMemoryProfile.maybeCapture({
          reason: "test",
          snapshot: pressured,
          soft: false,
          development: true,
        })
      ).action,
    ).toBe("below_threshold")
  })
})
