import { expect, test } from "bun:test"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { AgendaStore } from "../../src/agenda/store"
import { testRuntime } from "../support/runtime"

test("empty activity history reports its absent optional index as missing", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const statuses: unknown[] = []
    const activity = await ObservabilityMetrics.withForwarder(
      (metric) => {
        if (
          metric.name === "storage.operation.duration" &&
          metric.labels?.operation === "read" &&
          metric.labels?.keyPrefix === "agenda"
        )
          statuses.push(metric.labels.status)
      },
      () => AgendaStore.listActivity({ scopeID: "home" }),
    )
    expect(activity.items).toEqual([])
    expect(activity.total).toBe(0)
    expect(statuses).toEqual(["missing"])
  })
})
