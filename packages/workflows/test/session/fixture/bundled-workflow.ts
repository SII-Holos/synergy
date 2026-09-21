import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkflowSessionService } from "../../../src/session/workflow"
import { registerWorkflowSessions } from "../../../src/session/register"

if (process.argv.includes("__storage-worker-runner")) {
  await import("@ericsanchezok/synergy-harness/storage/sqlite-worker")
  await new Promise(() => {})
}
const { RuntimeContext } = await import("@ericsanchezok/synergy-harness/lifecycle/context")
const { registerHarness } = await import("@ericsanchezok/synergy-harness/lifecycle")
const { registerConfig } = await import("../../../src/config-schema")
const path = await import("node:path")
const home = process.env.SYNERGY_TEST_HOME!
const runtime = RuntimeContext.create({ home, root: path.join(home, ".synergy"), env: process.env })
await runtime.run(async () => {
  registerHarness()
  registerConfig()
  registerWorkflowSessions()
  const { StorageMaintenance } = await import("@ericsanchezok/synergy-harness/storage/maintenance")
  await using maintenance = await StorageMaintenance.open()
  const { scope } = await Scope.fromDirectory(process.cwd())
  await ScopeContext.provide({
    scope,
    async fn() {
      const session = await Session.create({})
      const pending = await WorkflowSessionService.hasPendingExecution(session)
      const cleared = await WorkflowSessionService.setNone(session.id)
      if (pending || cleared.workflow) throw new Error("Empty workflow must remain idle")
      process.stdout.write("workflow-cleared")
    },
  })
})
runtime.dispose()
