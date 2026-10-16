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
export namespace WorkflowSessionService {
  export const lock = CoreWorkflow.lock
  export const setNone = CoreWorkflow.setNone
  export const hasPendingExecution = CoreWorkflow.hasPendingExecution
  export const set = CoreWorkflow.set
  export const setExtension = CoreWorkflow.setExtension
  export const current = CoreWorkflow.current
  export async function startLightloop(sessionID: string, instructions: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    SessionManager.assertIdle(sessionID)
    const trimmed = instructions.trim()
    if (!trimmed) throw new Error("instructions is required when starting Light Loop.")

    const session = await Session.get(sessionID)
    if (session.workflow) {
      const current = WorkflowKindRegistry.effectiveKind(session.workflow) ?? session.workflow.kind
      throw new WorkflowConflictError(current, `Cannot enable Light Loop while the ${current} workflow is active.`)
    }
    await assertNoActiveBlueprintLoop(session, "Light Loop")
    return Session.update(sessionID, (draft) => {
      if (draft.workflow) {
        const current = WorkflowKindRegistry.effectiveKind(draft.workflow) ?? draft.workflow.kind
        throw new WorkflowConflictError(current, `Cannot enable Light Loop while the ${current} workflow is active.`)
      }
      draft.workflow = { kind: "lightloop", instructions: trimmed }
    })
  }

  export async function updateLightloopInstructions(sessionID: string, instructions: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    const trimmed = instructions.trim()
    if (!trimmed) throw new Error("instructions is required when updating Light Loop.")

    return Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop") {
        throw new Error("Session does not have an active Light Loop workflow.")
      }
      draft.workflow.instructions = trimmed
    })
  }

  export async function cancelLightloop(sessionID: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    const contribution = WorkflowPromptRegistry.get("lightloop")
    if (!contribution?.cancel) throw new Error("Light Loop is not registered")
    return (await contribution.cancel(sessionID)) as Session.Info
  }
}
