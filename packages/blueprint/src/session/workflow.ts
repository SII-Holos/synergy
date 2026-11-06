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
  export async function assertBlueprintLoopAllowed(session: Session.Info, source: BlueprintLoopSource): Promise<void> {
    const workflow = session.workflow
    if (source === "user") {
      if (!workflow) return
      throw new Error(`User BlueprintLoops cannot start while the ${workflow.kind} workflow is active.`)
    }
    // Plugin-owned loops are independently gated by the blueprint.delegate capability.
    if (source === "plugin") return

    if (WorkflowKindRegistry.effectiveKind(workflow) === "lattice") return
    if (!workflow) {
      throw new Error("Lattice-owned BlueprintLoops require an active Lattice workflow.")
    }
    throw new Error(`Lattice-owned BlueprintLoops cannot start while the ${workflow.kind} workflow is active.`)
  }

  export async function prepareBlueprintLoopBinding(
    sessionID: string,
    source: BlueprintLoopSource,
  ): Promise<Session.Info> {
    const session = await Session.get(sessionID)
    const workflow = session.workflow
    // Plugin-owned loops do not replace or depend on the Session's interactive workflow.
    if (source === "plugin") return session
    if (source === "user") {
      if (!workflow) return session
      if (workflow.kind === "plan" || WorkflowKindRegistry.effectiveKind(workflow) === "lightloop") {
        SessionManager.assertIdle(sessionID)
        return setNone(sessionID)
      }
      throw new Error(`User BlueprintLoops cannot start while the ${workflow.kind} workflow is active.`)
    }

    await assertBlueprintLoopAllowed(session, source)
    return session
  }

  export async function enablePlan(sessionID: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow) {
      const current = WorkflowKindRegistry.effectiveKind(session.workflow) ?? session.workflow.kind
      throw new WorkflowConflictError(current, `Cannot enable Plan while the ${current} workflow is active.`)
    }
    await assertNoActiveBlueprintLoop(session, "Plan")
    return Session.update(sessionID, (draft) => {
      if (draft.workflow) {
        const current = WorkflowKindRegistry.effectiveKind(draft.workflow) ?? draft.workflow.kind
        throw new WorkflowConflictError(current, `Cannot enable Plan while the ${current} workflow is active.`)
      }
      draft.workflow = { kind: "plan" }
    })
  }
}
