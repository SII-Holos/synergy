import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import {
  SessionWorkflowService as CoreWorkflow,
  WorkflowConflictError,
} from "@ericsanchezok/synergy-harness/session/workflow"
import "../session-schema"
export { WorkflowConflictError }
const workflowLock = CoreWorkflow.lock
const assertNoActiveBlueprintLoop = SessionExecutionContributions.assertWorkflowAllowed
type BlueprintLoopSource = "user" | "lattice" | "plugin"
export namespace WorkflowSessionService {
  export const lock = CoreWorkflow.lock
  export const setNone = CoreWorkflow.setNone
  export const hasPendingExecution = CoreWorkflow.hasPendingExecution
  export const set = CoreWorkflow.set
  export const setExtension = CoreWorkflow.setExtension
  export const current = CoreWorkflow.current
  export async function enableBoss(sessionID: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow) {
      const current = WorkflowKindRegistry.effectiveKind(session.workflow) ?? session.workflow.kind
      throw new WorkflowConflictError(current, `Cannot enable Boss Mode while the ${current} workflow is active.`)
    }
    await assertNoActiveBlueprintLoop(session, "Boss Mode")
    return Session.update(sessionID, (draft) => {
      if (draft.workflow) {
        const current = WorkflowKindRegistry.effectiveKind(draft.workflow) ?? draft.workflow.kind
        throw new WorkflowConflictError(current, `Cannot enable Boss Mode while the ${current} workflow is active.`)
      }
      draft.workflow = { kind: "boss", role: "boss" }
    })
  }
}
