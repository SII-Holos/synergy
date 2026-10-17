import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { workbench } from "../../src/component"
import { PerformanceDashboard } from "../../src/performance/dashboard"

test("Workbench statistics omit optional resource owners which were not registered", async () => {
  await using runtime = await testRuntime({
    composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), workbench()]),
  })
  await runtime.run(async () => {
    const summary = await PerformanceDashboard.summary()
    expect(summary.resources.owners.map((row) => row.owner)).toEqual([
      "control_plane",
      "agent",
      "policy",
      "local_process",
    ])
  })
})
