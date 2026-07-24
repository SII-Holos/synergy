import { describe, expect, test } from "bun:test"
import {
  SESSION_MEMORY_WORKLOAD_CONTRACT_VERSION,
  sessionMemoryWorkerPoolSettings,
} from "../../script/session-memory-runtime-settings"

describe("session memory runtime settings", () => {
  test("pins the elastic worker lifecycle in the workload contract", () => {
    const settings = sessionMemoryWorkerPoolSettings({
      scenario: "parallel",
      fullTrajectory: true,
    })

    expect(SESSION_MEMORY_WORKLOAD_CONTRACT_VERSION).toBeGreaterThan(1)
    expect(settings).toEqual({
      agentWorkers: 5,
      agentWorkerMinIdle: 0,
      agentWorkerIdleTimeoutMs: 60_000,
      agentWorkerMaxTurns: 64,
      agentWorkerIdleBaselineRecycle: true,
      agentWorkerIdleBaselineRssGrowthMb: 256,
      agentWorkerIdleBaselineExternalGrowthMb: 128,
    })
  })

  test("changes only the concurrency ceiling for smaller scenarios", () => {
    expect(
      sessionMemoryWorkerPoolSettings({
        scenario: "trajectory",
        fullTrajectory: false,
      }),
    ).toMatchObject({
      agentWorkers: 4,
      agentWorkerMinIdle: 0,
      agentWorkerIdleTimeoutMs: 60_000,
    })
  })
})
