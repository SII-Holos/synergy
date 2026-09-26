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

const GIB = 1024 * 1024 * 1024

function budget(limitBytes: number) {
  return { totalBytes: limitBytes, limitBytes, source: "host" as const }
}

describe("resolveExecutionConfiguration", () => {
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
  test("shrinks to a single worker when the memory budget admits no more", () =>
    runtime.run(() => {
      expect(resolveAgentWorkerCapacity({} as Config.Info, "server", budget(4 * GIB))).toEqual({
        size: 1,
        source: "derived",
      })
    }))

  test("never lowers capacity as the memory budget grows", () =>
    runtime.run(() => {
      const sizes = [4, 16, 62].map(
        (gib) => resolveAgentWorkerCapacity({} as Config.Info, "server", budget(gib * GIB)).size,
      )
      expect(sizes[0]).toBeLessThanOrEqual(sizes[1])
      expect(sizes[1]).toBeLessThanOrEqual(sizes[2])
    }))

  test("reports whether the capacity came from configuration or the machine", () =>
    runtime.run(() => {
      expect(resolveAgentWorkerCapacity({} as Config.Info, "server", budget(62 * GIB)).source).toBe("derived")
      expect(
        resolveAgentWorkerCapacity({ execution: { agentWorkers: 3 } } as Config.Info, "server", budget(62 * GIB)),
      ).toEqual({ size: 3, source: "explicit" })
    }))

  test("honors an explicit capacity even when the machine would derive less", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkers: 64 } } as Config.Info
      expect(resolveAgentWorkerCapacity(config, "server", budget(4 * GIB))).toEqual({ size: 64, source: "explicit" })
    }))

  test("honors an explicit capacity of one", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkers: 1 } } as Config.Info
      expect(resolveAgentWorkerCapacity(config, "server", budget(62 * GIB))).toEqual({ size: 1, source: "explicit" })
    }))

  test("treats a cleared (null) capacity as unset and derives it again", () =>
    runtime.run(() => {
      const cleared = { execution: { agentWorkers: null } } as Config.Info
      expect(resolveAgentWorkerCapacity(cleared, "server", budget(62 * GIB))).toEqual(
        resolveAgentWorkerCapacity({} as Config.Info, "server", budget(62 * GIB)),
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
      expect(
        agentWorkerCapacityStatus({ execution: { agentWorkers: 6 } } as Config.Info, "server", budget(4 * GIB)),
      ).toEqual({ configured: 6, effective: 6, source: "explicit" })
      const derived = agentWorkerCapacityStatus({} as Config.Info, "server", budget(62 * GIB))
      expect(derived).toEqual({ configured: null, effective: derived.effective, source: "derived" })
      expect(
        agentWorkerCapacityStatus({ execution: { agentWorkers: null } } as Config.Info, "server", budget(62 * GIB)),
      ).toEqual(derived)
    }))

  test("never derives a capacity below the resolved warm reserve", () =>
    runtime.run(() => {
      const config = { execution: { agentWorkerMinIdle: 4 } } as Config.Info
      expect(resolveAgentWorkerCapacity(config, "server", budget(4 * GIB))).toEqual({ size: 4, source: "derived" })
    }))

  test("grows capacity when the per-worker RSS reserve shrinks", () =>
    runtime.run(() => {
      const trimmed = { execution: { agentWorkerMaxRssMb: 768 } } as Config.Info
      expect(resolveAgentWorkerCapacity(trimmed, "server", budget(62 * GIB)).size).toBeGreaterThanOrEqual(
        resolveAgentWorkerCapacity({} as Config.Info, "server", budget(62 * GIB)).size,
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
