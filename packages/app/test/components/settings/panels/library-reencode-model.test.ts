import { describe, expect, test } from "bun:test"
import type { ReencodeJobState } from "@ericsanchezok/synergy-sdk/client"
import {
  isReencodeJobNotFound,
  pollReencodeJob,
  reencodeConflictJob,
  reencodeJobSummary,
} from "../../../../src/components/settings/panels/library-reencode-model"

function job(status: ReencodeJobState["status"], completedCount = 0): ReencodeJobState {
  return {
    id: "job-1",
    status,
    type: "intent",
    reason: null,
    totalCount: 2,
    okCount: completedCount,
    skippedCount: 0,
    failedCount: 0,
    completedCount,
    startedAt: 1,
    completedAt: status === "running" ? null : 2,
    error: status === "failed" ? "provider unavailable" : null,
  }
}

describe("library reencode model", () => {
  test("polls sequentially until the durable job reaches a terminal state", async () => {
    const states = [job("running"), job("running", 1), job("completed", 2)]
    const updates: ReencodeJobState[] = []
    let active = 0
    let peak = 0

    const terminal = await pollReencodeJob({
      signal: new AbortController().signal,
      intervalMs: 0,
      async load() {
        active++
        peak = Math.max(peak, active)
        const state = states.shift()!
        await Promise.resolve()
        active--
        return state
      },
      onUpdate(state) {
        updates.push(state)
      },
    })

    expect(peak).toBe(1)
    expect(updates.map((state) => [state.status, state.completedCount])).toEqual([
      ["running", 0],
      ["running", 1],
      ["completed", 2],
    ])
    expect(terminal?.status).toBe("completed")
  })

  test("stops polling when the observer is aborted", async () => {
    const controller = new AbortController()
    let calls = 0

    const terminal = await pollReencodeJob({
      signal: controller.signal,
      intervalMs: 0,
      async load() {
        calls++
        return job("running")
      },
      onUpdate() {
        controller.abort()
      },
    })

    expect(calls).toBe(1)
    expect(terminal).toBeUndefined()
  })

  test("extracts structured API errors and summarizes terminal history", () => {
    const running = job("running")
    expect(reencodeConflictJob({ code: "REENCODE_JOB_ALREADY_RUNNING", job: running })).toEqual(running)
    expect(reencodeConflictJob({ code: "OTHER" })).toBeUndefined()
    expect(isReencodeJobNotFound({ code: "REENCODE_JOB_NOT_FOUND" })).toBe(true)
    expect(reencodeJobSummary(job("completed", 2))).toBe("Complete: 2 updated, 0 skipped, 0 failed")
    expect(reencodeJobSummary(job("cancelled", 1))).toBe("Cancelled after 1 of 2: 1 updated, 0 skipped, 0 failed")
    expect(reencodeJobSummary(job("failed", 1))).toBe("Failed after 1 of 2: provider unavailable")
  })
})
