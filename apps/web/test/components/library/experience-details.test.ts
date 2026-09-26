import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ExperienceDetailInfo } from "@ericsanchezok/synergy-sdk/client"
import { createExperienceDetails } from "../../../src/components/library/experience-details"

test("detail failure settles locally, retries once and preserves other cards", async () => {
  let calls = 0
  let fail = true
  const mounted = createRoot((dispose) => ({
    dispose,
    details: createExperienceDetails(async (id) => {
      calls++
      if (id === "failed" && fail) throw new Error("offline")
      return { id, intent: "Retained content" } as ExperienceDetailInfo
    }),
  }))
  try {
    await mounted.details.load("good")
    await Promise.all([mounted.details.load("failed"), mounted.details.load("failed")])
    expect(calls).toBe(2)
    expect(mounted.details.read("failed")?.loading).toBe(false)
    expect(mounted.details.read("failed")?.error).toBeInstanceOf(Error)
    expect(mounted.details.read("good")?.data?.intent).toBe("Retained content")
    fail = false
    await mounted.details.load("failed")
    expect(mounted.details.read("failed")?.error).toBeUndefined()
    expect(mounted.details.read("failed")?.data?.id).toBe("failed")
  } finally {
    mounted.dispose()
  }
})

test("unmount aborts detail reads and ignores their late results", async () => {
  const pending = Promise.withResolvers<ExperienceDetailInfo>()
  let signal: AbortSignal | undefined
  const mounted = createRoot((dispose) => ({
    dispose,
    details: createExperienceDetails(async (_, next) => {
      signal = next
      return pending.promise
    }),
  }))
  const result = mounted.details.load("old")
  mounted.dispose()
  expect(signal?.aborted).toBe(true)
  pending.resolve({ id: "old" } as ExperienceDetailInfo)
  await result
  expect(mounted.details.read("old")?.data).toBeUndefined()
})
