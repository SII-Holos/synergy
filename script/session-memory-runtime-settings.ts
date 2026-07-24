export type SessionMemoryBenchmarkScenario = "trajectory" | "parallel" | "sequential"

export const SESSION_MEMORY_WORKLOAD_CONTRACT_VERSION = 2

const RUNTIME_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const

export function sessionMemoryWorkerPoolSettings(input: {
  scenario: SessionMemoryBenchmarkScenario
  fullTrajectory: boolean
}) {
  const agentWorkers =
    input.scenario === "parallel"
      ? input.fullTrajectory
        ? 5
        : 2
      : input.scenario === "sequential" && !input.fullTrajectory
        ? 2
        : 4
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

export function sessionMemoryRuntimeEnvironment(input: {
  source: NodeJS.ProcessEnv
  home: string
  cwd: string
  configContent: string
}) {
  const env: Record<string, string> = {}
  for (const key of RUNTIME_ENV_ALLOWLIST) {
    const value = input.source[key]
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    SYNERGY_HOME: input.home,
    SYNERGY_CWD: input.cwd,
    SYNERGY_CONFIG_CONTENT: input.configContent,
    SYNERGY_BENCHMARK_API_KEY: "local-benchmark-key",
    SYNERGY_DISABLE_LSP_DOWNLOAD: "1",
    NO_PROXY: "localhost,127.0.0.1,::1",
  }
}
