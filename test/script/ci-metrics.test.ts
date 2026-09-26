import { expect, test } from "bun:test"
import { summarize } from "../../script/ci/metrics"

test("queue and compute accounting ignore inherited attempts, duplicates and unstarted jobs", () => {
  const row = {
    id: 1,
    name: "linux",
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-24T00:01:00Z",
    started_at: "2026-09-24T00:02:00Z",
    completed_at: "2026-09-24T00:04:00Z",
    runner_name: "runner",
    labels: ["ubuntu-24.04"],
    run_attempt: 2,
  }
  const value = summarize(
    "2026-09-24T00:00:00Z",
    [
      row,
      row,
      { ...row, id: 2, run_attempt: 1 },
      { ...row, id: 3, started_at: null, completed_at: null, status: "queued" },
    ],
    Date.parse("2026-09-24T00:05:00Z"),
    2,
  )
  expect(value.runnerSeconds).toBe(120)
  expect(value.endToEndSeconds).toBe(300)
  expect(value.jobs).toHaveLength(2)
  expect(value.jobs[0]!.queueSeconds).toBe(60)
  expect(value.jobs[1]!.queueSeconds).toBe(240)
})
