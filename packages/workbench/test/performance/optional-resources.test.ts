import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
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

test("performance summary retains sessions waiting for resource admission", async () => {
  await using runtime = await testRuntime({
    composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), workbench()]),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ title: "Waiting for resources" })
        const lease = SessionManager.acquire(session.id)!
        try {
          SessionManager.setExecutionPhase(session.id, "waiting_resources")
          const summary = await PerformanceDashboard.summary()
          expect(summary.runtime.sessionRuntimes).toMatchObject({
            runningCount: 1,
            executionPhases: { waiting_resources: 1 },
          })
        } finally {
          await SessionManager.finish(lease, { requestNextWork: false })
          await Session.remove(session.id)
        }
      },
    }),
  )
})
