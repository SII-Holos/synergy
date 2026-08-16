import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityStore } from "../../src/observability/store"
import { Storage } from "../../src/storage/storage"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

beforeEach(() => {
  resetObservabilityHome("synergy-storage-silent-")
  ObservabilityStore.open()
})

afterEach(() => {
  cleanupObservabilityHomes()
})

describe("storage silent NotFound reads", () => {
  test("expected missing reads raise no issue but still record the error metric", async () => {
    const key = ["storage-silent", Math.random().toString(36).slice(2), "missing"]

    await expect(Storage.read(key, { silentNotFound: true })).rejects.toThrow()
    ObservabilityStore.flush()

    const issues = ObservabilityIssues.list({ module: "storage" })
    expect(issues.filter((issue) => issue.code === "PERF_STORAGE_OPERATION_ERROR")).toHaveLength(0)

    const errorRows = ObservabilityStore.queryMetrics({
      since: 0,
      names: ["storage.operation.error"],
    })
    expect(errorRows.length).toBeGreaterThan(0)
  })

  test("unexpected missing reads still raise the storage issue", async () => {
    const key = ["storage-silent", Math.random().toString(36).slice(2), "missing"]

    await expect(Storage.read(key)).rejects.toThrow()
    ObservabilityStore.flush()

    const issues = ObservabilityIssues.list({ module: "storage" })
    expect(issues.filter((issue) => issue.code === "PERF_STORAGE_OPERATION_ERROR").length).toBeGreaterThan(0)
  })

  test("silentNotFound is a no-op for successful reads", async () => {
    const key = ["storage-silent", Math.random().toString(36).slice(2), "present"]
    await Storage.write(key, { ok: true })

    expect(await Storage.read<{ ok: boolean }>(key, { silentNotFound: true })).toEqual({ ok: true })
  })
})
