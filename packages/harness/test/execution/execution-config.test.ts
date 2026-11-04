import { describe, expect, test } from "bun:test"
import type { Config } from "../../src/config/config"
import {
  agentWorkerCapacityStatus,
  resolveAgentWorkerCapacity,
  resolveExecutionConfiguration,
} from "../../src/execution/execution-config"
import { DEFAULT_AGENT_WORKER_POOL_OPTIONS } from "../../src/session/agent-turn/worker-pool"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("resolveExecutionConfiguration", () => {
  test("keeps policy prewarming enabled by default and preserves an explicit lazy selection", () =>
    runtime.run(() => {
      expect(resolveExecutionConfiguration({} as Config.Info, "server").execution?.policyWorkerPrewarm).toBe(true)
      expect(
        resolveExecutionConfiguration({ execution: { policyWorkerPrewarm: false } } as Config.Info, "server").execution
          ?.policyWorkerPrewarm,
      ).toBe(false)
    }))

  test("applies the warm Agent worker reserve only to resident servers", () =>
    runtime.run(() => {
      expect(resolveExecutionConfiguration({} as Config.Info, "server").execution?.agentWorkerMinIdle).toBe(
        DEFAULT_AGENT_WORKER_POOL_OPTIONS.minIdle,
      )
      expect(resolveExecutionConfiguration({} as Config.Info, "oneshot").execution?.agentWorkerMinIdle).toBe(0)
    }))

  test("keeps an explicit agentWorkerMinIdle override in every mode", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkerMinIdle: 2 } } as Config.Info
      expect(resolveExecutionConfiguration(config, "server").execution?.agentWorkerMinIdle).toBe(2)
      expect(resolveExecutionConfiguration(config, "oneshot").execution?.agentWorkerMinIdle).toBe(2)
    }))
})

describe("resolveAgentWorkerCapacity", () => {
  test("keeps worker hard limits absent by default and preserves explicit old-default values", () =>
    runtime.run(() => {
      const defaults = resolveExecutionConfiguration({}, "server").execution
      expect(defaults?.agentWorkerMaxRssMb).toBeUndefined()
      expect(defaults?.agentWorkerMaxHeapMb).toBeUndefined()
      const explicit = resolveExecutionConfiguration(
        { execution: { agentWorkerMaxRssMb: 3072, agentWorkerMaxHeapMb: 2048 } },
        "server",
      ).execution
      expect(explicit?.agentWorkerMaxRssMb).toBe(3072)
      expect(explicit?.agentWorkerMaxHeapMb).toBe(2048)
    }))

  test("reports whether the capacity came from configuration or the machine", () =>
    runtime.run(() => {
      expect(resolveAgentWorkerCapacity({} as Config.Info, "server").source).toBe("derived")
      expect(resolveAgentWorkerCapacity({ execution: { agentWorkers: 3 } } as Config.Info, "server")).toEqual({
        size: 3,
        source: "explicit",
      })
    }))

  test("honors an explicit capacity even when the machine would derive less", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkers: 64 } } as Config.Info
      expect(resolveAgentWorkerCapacity(config, "server")).toEqual({ size: 64, source: "explicit" })
    }))

  test("honors an explicit capacity of one", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkers: 1 } } as Config.Info
      expect(resolveAgentWorkerCapacity(config, "server")).toEqual({ size: 1, source: "explicit" })
    }))

  test("treats a cleared (null) capacity as unset and derives it again", () =>
    runtime.run(() => {
      const cleared = { execution: { agentWorkers: null } } as Config.Info
      expect(resolveAgentWorkerCapacity(cleared, "server")).toEqual(
        resolveAgentWorkerCapacity({} as Config.Info, "server"),
      )
    }))

  test("materializes the derived capacity after an explicit ceiling is cleared", () =>
    runtime.run(() => {
      const resolved = resolveExecutionConfiguration({ execution: { agentWorkers: null } } as Config.Info, "server")
      expect(resolved.execution?.agentWorkers).toBe(resolveAgentWorkerCapacity({} as Config.Info, "server").size)
      expect(resolved.execution?.agentWorkers).toBeGreaterThanOrEqual(1)
    }))

  test("reports the resolved capacity and its source for the settings surface", () =>
    runtime.run(() => {
      expect(agentWorkerCapacityStatus({ execution: { agentWorkers: 6 } } as Config.Info, "server")).toEqual({
        configured: 6,
        ceiling: 6,
        workers: 0,
        active: 0,
        queued: 0,
        source: "explicit",
      })
      const derived = agentWorkerCapacityStatus({} as Config.Info, "server")
      expect(derived).toEqual({
        configured: null,
        ceiling: derived.ceiling,
        workers: 0,
        active: 0,
        queued: 0,
        source: "derived",
      })
      expect(agentWorkerCapacityStatus({ execution: { agentWorkers: null } } as Config.Info, "server")).toEqual(derived)
    }))

  test("never derives a capacity below the resolved warm reserve", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkerMinIdle: 4 } } as Config.Info
      expect(resolveAgentWorkerCapacity(config, "server").size).toBeGreaterThanOrEqual(4)
    }))

  test("does not derive a second capacity from per-worker RSS limits", () =>
    runtime.run(() => {
      const trimmed = { execution: { agentWorkerMaxRssMb: 768 } } as Config.Info
      expect(resolveAgentWorkerCapacity(trimmed, "server").size).toBe(
        resolveAgentWorkerCapacity({} as Config.Info, "server").size,
      )
    }))

  test("materializes the derived capacity into the resolved configuration", () =>
    runtime.run(() => {
      const resolved = resolveExecutionConfiguration({} as Config.Info, "server")
      expect(resolved.execution?.agentWorkers).toBe(resolveAgentWorkerCapacity({} as Config.Info, "server").size)
      expect(resolved.execution?.agentWorkers).toBeGreaterThanOrEqual(1)
    }))

  test("clamps the warm reserve to an explicit capacity so the pair stays constructible", () =>
    runtime.run(() => {
      for (const minIdle of [0, 1, 2, 4, 64]) {
        const config = { execution: { agentWorkers: 1, agentWorkerMinIdle: minIdle } } as Config.Info
        const resolved = resolveExecutionConfiguration(config, "server")
        expect(resolved.execution?.agentWorkers).toBe(1)
        expect(resolved.execution?.agentWorkerMinIdle).toBeLessThanOrEqual(1)
      }
    }))

  test("keeps an explicit warm reserve that fits under the capacity", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkers: 8, agentWorkerMinIdle: 4 } } as Config.Info
      const resolved = resolveExecutionConfiguration(config, "server")
      expect(resolved.execution?.agentWorkers).toBe(8)
      expect(resolved.execution?.agentWorkerMinIdle).toBe(4)
    }))

  test("raises a derived capacity to the configured warm reserve", () =>
    runtime.run(() => {
      const resolved = resolveExecutionConfiguration({ execution: { agentWorkerMinIdle: 4 } } as Config.Info, "server")
      expect(resolved.execution?.agentWorkerMinIdle).toBe(4)
      expect(resolved.execution?.agentWorkers).toBeGreaterThanOrEqual(4)
    }))
})

afterRuntimeTests(() => runtime.close())
