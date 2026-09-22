import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityStore } from "../../src/observability/store"
import { StorageRetention } from "../../src/storage/retention"
import { Storage } from "../../src/storage/storage"
import { clearObservabilityState, resetObservabilityState } from "../observability/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const SWEEP_INTERVAL_MS = 15 * 60_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

beforeEach(() =>
  runtime.run(() => {
    resetObservabilityState()
    ObservabilityStore.open()
  }),
)

afterEach(() =>
  runtime.run(() => {
    StorageRetention.stop()
    jest.useRealTimers()
    clearObservabilityState()
  }),
)

describe("retention pass failure reporting", () => {
  test("a scheduled pass that cannot enumerate raises STORAGE_RETENTION_PASS_FAILED", () =>
    runtime.run(async () => {
      let enumerations = 0
      const instrumented = {
        store: {
          sqliteFilename: undefined,
          evidenceOwners: async () => {
            enumerations++
            throw new Error("owner enumeration failed")
          },
        },
        artifactDirectory: "/nonexistent-artifact-directory",
      }

      jest.useFakeTimers()
      await Storage.provide(instrumented as never, async () => {
        StorageRetention.schedule({
          current: () => ({ retentionMs: WEEK_MS, maxBytes: 0 }),
          liveSessionIDs: () => [],
        })
        // The pass runs on a fixed sweep cadence, and the tick that starts it is
        // what reaches the enumeration. Nothing else here is time-dependent.
        jest.advanceTimersByTime(SWEEP_INTERVAL_MS)
        for (let turn = 0; turn < 50; turn++) await Promise.resolve()
      })
      jest.useRealTimers()

      expect(enumerations).toBeGreaterThan(0)
      ObservabilityStore.flush()

      const issues = ObservabilityIssues.list({ module: "storage" }).filter(
        (issue) => issue.code === "STORAGE_RETENTION_PASS_FAILED",
      )
      expect(issues).toHaveLength(1)
      expect(issues[0].severity).toBe("warning")
      expect(issues[0].status).toBe("open")
      // The evidence names the failure without copying its message into the store.
      expect(issues[0].evidence).toMatchObject({ errorName: "Error" })
      expect(JSON.stringify(issues[0])).not.toContain("owner enumeration failed")
    }))

  test("a pass that enumerates without failing raises no failure issue", () =>
    runtime.run(async () => {
      const stub = {
        store: { sqliteFilename: undefined, evidenceOwners: async () => [] },
        artifactDirectory: "/nonexistent-artifact-directory",
      }

      jest.useFakeTimers()
      await Storage.provide(stub as never, async () => {
        StorageRetention.schedule({
          current: () => ({ retentionMs: WEEK_MS, maxBytes: 0 }),
          liveSessionIDs: () => [],
        })
        jest.advanceTimersByTime(SWEEP_INTERVAL_MS)
        for (let turn = 0; turn < 50; turn++) await Promise.resolve()
      })
      jest.useRealTimers()

      ObservabilityStore.flush()
      const issues = ObservabilityIssues.list({ module: "storage" }).filter(
        (issue) => issue.code === "STORAGE_RETENTION_PASS_FAILED",
      )
      expect(issues).toHaveLength(0)
    }))

  test("an unconfigured retention window never enumerates", () =>
    runtime.run(async () => {
      let enumerations = 0
      const stub = {
        store: {
          sqliteFilename: undefined,
          evidenceOwners: async () => {
            enumerations++
            return []
          },
        },
        artifactDirectory: "/nonexistent-artifact-directory",
      }

      jest.useFakeTimers()
      await Storage.provide(stub as never, async () => {
        StorageRetention.schedule({
          current: () => ({ retentionMs: 0, maxBytes: 0 }),
          liveSessionIDs: () => [],
        })
        jest.advanceTimersByTime(SWEEP_INTERVAL_MS * 4)
        for (let turn = 0; turn < 50; turn++) await Promise.resolve()
      })
      jest.useRealTimers()

      expect(enumerations).toBe(0)
      expect(ObservabilityConfig.current().storage.retentionMs).toBeGreaterThanOrEqual(0)
    }))
})

afterRuntimeTests(() => runtime.close())
