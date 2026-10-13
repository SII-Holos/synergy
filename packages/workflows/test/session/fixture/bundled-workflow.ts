import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { WorkflowSessionService } from "../../../src/session/workflow"
import { workflowComponents } from "../../../src/component"

if (process.argv.includes("__storage-worker-runner")) {
  await import("@ericsanchezok/synergy-harness/storage/sqlite-worker")
  await new Promise(() => {})
}
const { RuntimeContext } = await import("@ericsanchezok/synergy-harness/lifecycle/context")
const { RuntimeComponents } = await import("@ericsanchezok/synergy-harness/lifecycle")
const path = await import("node:path")
const home = process.env.SYNERGY_TEST_HOME!
const runtime = RuntimeContext.create({ home, root: path.join(home, ".synergy"), env: process.env })
await runtime.run(async () => {
  RuntimeComponents.compose([
    localRuntime({ workers: false, environment: false }),
    library(),
    note(),
    ...workflowComponents(),
  ]).register()
  const { StorageMaintenance } = await import("@ericsanchezok/synergy-harness/storage/maintenance")
  await using maintenance = await StorageMaintenance.open()
  const { scope } = await Scope.fromDirectory(process.cwd())
  await ScopeContext.provide({
    scope,
    workspace: null,
    async fn() {
      const session = await Session.create({ workspace: null })
      const pending = await WorkflowSessionService.hasPendingExecution(session)
      const cleared = await WorkflowSessionService.setNone(session.id)
      if (pending || cleared.workflow) throw new Error("Empty workflow must remain idle")
      process.stdout.write("workflow-cleared")
    },
  })
})
runtime.dispose()
