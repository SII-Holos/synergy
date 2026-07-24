export type SessionMemoryBenchmarkScenario = "trajectory" | "parallel" | "sequential"

export const SESSION_MEMORY_WORKLOAD_CONTRACT_VERSION = 2

export function sessionMemoryWorkerPoolSettings(input: {
  scenario: SessionMemoryBenchmarkScenario
  fullTrajectory: boolean
}) {
  const agentWorkers = input.scenario === "parallel" ? (input.fullTrajectory ? 5 : 2) : 4
  return {
    agentWorkers,
    agentWorkerMinIdle: 0,
    agentWorkerIdleTimeoutMs: 60_000,
    agentWorkerMaxTurns: 64,
    agentWorkerIdleBaselineRecycle: true,
    agentWorkerIdleBaselineRssGrowthMb: 256,
    agentWorkerIdleBaselineExternalGrowthMb: 128,
  }
}
