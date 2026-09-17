import { describe, expect, test } from "bun:test"
import type { Config } from "../../src/config/config"
import { resolveExecutionConfiguration } from "../../src/execution/execution-config"
import { DEFAULT_AGENT_WORKER_POOL_OPTIONS } from "../../src/session/agent-turn/worker-pool"

describe("resolveExecutionConfiguration", () => {
  test("applies the warm Agent worker reserve only to resident servers", () => {
    expect(resolveExecutionConfiguration({} as Config.Info, "server").execution?.agentWorkerMinIdle).toBe(
      DEFAULT_AGENT_WORKER_POOL_OPTIONS.minIdle,
    )
    expect(resolveExecutionConfiguration({} as Config.Info, "oneshot").execution?.agentWorkerMinIdle).toBe(0)
  })

  test("keeps an explicit agentWorkerMinIdle override in every mode", () => {
    const config = { execution: { agentWorkerMinIdle: 2 } } as Config.Info
    expect(resolveExecutionConfiguration(config, "server").execution?.agentWorkerMinIdle).toBe(2)
    expect(resolveExecutionConfiguration(config, "oneshot").execution?.agentWorkerMinIdle).toBe(2)
  })
})
