import { describe, expect, test } from "bun:test"
import {
  SESSION_MEMORY_WORKLOAD_CONTRACT_VERSION,
  sessionMemoryRuntimeEnvironment,
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

  test("uses the documented worker ceilings for smoke and standard scenarios", () => {
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
    expect(
      sessionMemoryWorkerPoolSettings({
        scenario: "sequential",
        fullTrajectory: false,
      }),
    ).toMatchObject({
      agentWorkers: 2,
      agentWorkerMinIdle: 0,
      agentWorkerIdleTimeoutMs: 60_000,
    })
    expect(
      sessionMemoryWorkerPoolSettings({
        scenario: "sequential",
        fullTrajectory: true,
      }),
    ).toMatchObject({
      agentWorkers: 4,
      agentWorkerMinIdle: 0,
      agentWorkerIdleTimeoutMs: 60_000,
    })
  })

  test("builds an allowlisted child environment without ambient credentials or tuning", () => {
    const env = sessionMemoryRuntimeEnvironment({
      source: {
        PATH: "/runtime/bin",
        TMPDIR: "/runtime/tmp",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "provider-secret",
        GH_TOKEN: "github-secret",
        HTTP_PROXY: "http://proxy.invalid",
        NODE_OPTIONS: "--inspect",
        SYNERGY_SESSION_GC_MIN_INTERVAL_MS: "1",
      },
      home: "/isolated/home",
      cwd: "/isolated/workspace",
      configContent: '{"isolated":true}',
    })

    expect(env).toEqual({
      PATH: "/runtime/bin",
      TMPDIR: "/runtime/tmp",
      LANG: "en_US.UTF-8",
      SYNERGY_HOME: "/isolated/home",
      SYNERGY_CWD: "/isolated/workspace",
      SYNERGY_CONFIG_CONTENT: '{"isolated":true}',
      SYNERGY_BENCHMARK_API_KEY: "local-benchmark-key",
      SYNERGY_DISABLE_LSP_DOWNLOAD: "1",
      NO_PROXY: "localhost,127.0.0.1,::1",
    })
  })
})
