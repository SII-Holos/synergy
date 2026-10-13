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
  export type SetInput = { kind: "lattice"; mode: "auto" | "collaborative"; maxModelCalls?: number; goal?: string }
  export async function clearIfLattice(sessionID: string, expectedRunID: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow?.kind !== "lattice" || session.workflow.runID !== expectedRunID) return session
    return clearLatticeProjectionExact(sessionID, expectedRunID)
  }

  export async function clearLatticeProjectionExact(sessionID: string, expectedRunID: string): Promise<Session.Info> {
    return Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind === "lattice" && draft.workflow.runID === expectedRunID) {
        draft.workflow = undefined
      }
    })
  }

  export async function repairLatticeProjection(input: {
    sessionID: string
    runID: string
    mode: "auto" | "collaborative"
  }): Promise<Session.Info> {
    return Session.update(input.sessionID, (draft) => {
      const workflow = draft.workflow
      if (!workflow) {
        draft.workflow = { kind: "lattice", runID: input.runID, mode: input.mode }
        return
      }
      if (workflow.kind === "lattice" && workflow.runID === input.runID) {
        workflow.mode = input.mode
        return
      }
      throw new Error(
        `Session workflow is owned by ${workflow.kind}:${"runID" in workflow ? workflow.runID : "active"}.`,
      )
    })
  }

  export async function enableLattice(
    sessionID: string,
    input: Extract<SetInput, { kind: "lattice" }>,
  ): Promise<Session.Info> {
    const contribution = WorkflowPromptRegistry.get("lattice")
    if (!contribution?.enable) {
      throw new Error("Lattice workflow is not registered (load src/registration)")
    }
    return contribution.enable(sessionID, {
      mode: input.mode,
      maxModelCalls: input.maxModelCalls,
      goal: input.goal,
    })
  }
}
