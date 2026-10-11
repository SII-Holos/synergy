import { expect, test } from "bun:test"
import { trustedTimingRun, timingArtifact } from "../../script/ci/timing-source"

const now = Date.parse("2026-10-09T00:00:00Z")
const run = {
  id: 42,
  run_attempt: 2,
  head_branch: "dev",
  head_sha: "a".repeat(40),
  event: "push",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  updated_at: "2026-10-08T00:00:00Z",
  head_repository: { full_name: "fixture/repo" },
}

test("weights come only from a recent successful trusted development CI execution", () => {
  expect(trustedTimingRun([run], "fixture/repo", now)).toEqual(run)
  for (const change of [
    { event: "pull_request" },
    { head_branch: "feature" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { head_repository: { full_name: "fork/repo" } },
    { path: ".github/workflows/other.yml" },
    { updated_at: "2026-09-01T00:00:00Z" },
    { updated_at: "2026-11-01T00:00:00Z" },
  ])
    expect(trustedTimingRun([{ ...run, ...change }], "fixture/repo", now)).toBeUndefined()
})

test("timing input uses the exact producer attempt and refuses expired or oversized artifacts", () => {
  const artifact = { id: 12, name: "ci-summary-2", expired: false, size_in_bytes: 1000 }
  expect(timingArtifact([artifact], run)).toEqual(artifact)
  for (const change of [{ name: "ci-summary-1" }, { expired: true }, { size_in_bytes: 100_000_000 }])
    expect(timingArtifact([{ ...artifact, ...change }], run)).toBeUndefined()
})
