import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { ClarusAssignmentStore } from "./assignment-store"
import { ClarusDeadlineAgenda } from "./deadline-agenda"

const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerClarusAssignmentLifecycle(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true
  SessionAbort.registerHook(async (sessionID) => {
    const located = await ClarusAssignmentStore.cancel(sessionID)
    if (!located) return
    await ClarusDeadlineAgenda.cancel({
      accountId: located.assignment.accountId,
      projectID: located.assignment.projectID,
      taskID: located.assignment.taskID,
    })
  })
}
