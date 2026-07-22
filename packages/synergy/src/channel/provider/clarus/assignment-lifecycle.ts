import { SessionAbort } from "@/session/abort"
import { ClarusAssignmentStore } from "./assignment-store"
import { ClarusDeadlineAgenda } from "./deadline-agenda"

let registered = false

export function registerClarusAssignmentLifecycle(): void {
  if (registered) return
  registered = true
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
