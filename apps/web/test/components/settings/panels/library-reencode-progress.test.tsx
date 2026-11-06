import { describe, expect, test } from "bun:test"
const solidBrowserRuntime = "solid-js/dist/solid.js" as string
const { createMemo, createRoot, createSignal } = (await import(solidBrowserRuntime)) as typeof import("solid-js")
import type { ReencodeJobState } from "@ericsanchezok/synergy-sdk/client"
import { reencodeJobPercent } from "../../../../src/components/settings/panels/library-reencode-model"

function job(completedCount: number): ReencodeJobState {
  return {
    id: "job-1",
    status: "running",
    type: "intent",
    reason: null,
    totalCount: 10,
    okCount: completedCount,
    skippedCount: 0,
    failedCount: 0,
    completedCount,
    startedAt: 1,
    completedAt: null,
    error: null,
  }
}

describe("Library re-encode progress", () => {
  test("recomputes the meter percentage when durable job progress changes", () => {
    createRoot((dispose) => {
      const [current, setCurrent] = createSignal(job(0))
      const percent = createMemo(() => reencodeJobPercent(current()))

      expect(percent()).toBe(0)
      setCurrent(job(5))
      expect(percent()).toBe(50)

      dispose()
    })
  })

  test("handles empty and over-complete job counts safely", () => {
    expect(reencodeJobPercent({ ...job(0), totalCount: 0 })).toBe(0)
    expect(reencodeJobPercent(job(11))).toBe(100)
  })
})
