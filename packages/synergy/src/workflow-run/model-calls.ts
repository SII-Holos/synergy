import { WorkflowRunExecutor } from "./executor"
import { WorkflowRunStore } from "./store"

export namespace WorkflowModelCalls {
  export type Role = "boss" | "seat" | "contractor"

  export type Attribution = {
    runID: string
    role: Role
  }

  export interface AttributionSource {
    workflowRun?: { runID: string; role: "boss" | "seat" }
    cortex?: { owner?: { kind?: string; runID?: string } }
  }

  export type Reservation =
    | { ok: true; counted: boolean; used: number; maxModelCalls: number }
    | {
        ok: false
        reason: "budget_exhausted" | "run_not_active" | "run_not_found"
        message: string
        used?: number
        maxModelCalls?: number
      }

  /**
   * Persist one model-call reservation before the provider is invoked. The run
   * snapshot is the counter of record, so every active Boss, seat, and
   * contractor competes for the same hard limit even when their turns start
   * concurrently. A paused or terminal run fences workers but leaves its Boss
   * control plane conversational so it can resume, cancel, or start something
   * new without consuming execution budget.
   */
  export async function reserve(scopeID: string, attribution: Attribution): Promise<Reservation> {
    const { runID, role } = attribution
    return WorkflowRunExecutor.run(scopeID, runID, async () => {
      let exhausted = false
      const result = await WorkflowRunStore.tryUpdate(
        scopeID,
        runID,
        (run) => {
          if (run.budget.maxModelCalls > 0 && run.budget.used >= run.budget.maxModelCalls) {
            run.status = "paused"
            run.statusReason = "model_call_budget_exhausted"
            exhausted = true
            return
          }
          run.budget.used += 1
        },
        { expectedRunStatus: "active" },
      )

      if (!result.ok) {
        if (result.reason === "not_found") {
          return {
            ok: false,
            reason: "run_not_found",
            message: `Workflow run ${runID} no longer exists; the model call was not started.`,
          }
        }
        if (role === "boss" && result.run) {
          return {
            ok: true,
            counted: false,
            used: result.run.budget.used,
            maxModelCalls: result.run.budget.maxModelCalls,
          }
        }
        const status = result.run?.status ?? "unknown"
        return {
          ok: false,
          reason: "run_not_active",
          message: `Workflow run ${runID} is ${status}; the model call was not started.`,
          used: result.run?.budget.used,
          maxModelCalls: result.run?.budget.maxModelCalls,
        }
      }

      if (exhausted) {
        await WorkflowRunStore.appendEvent(scopeID, result.run, {
          kind: "budget_exhausted",
          message: `Model-call budget exhausted at ${result.run.budget.used}/${result.run.budget.maxModelCalls}.`,
        })
        return {
          ok: false,
          reason: "budget_exhausted",
          message: `Workflow run ${runID} exhausted its model-call budget (${result.run.budget.used}/${result.run.budget.maxModelCalls}); the run was paused and the model call was not started.`,
          used: result.run.budget.used,
          maxModelCalls: result.run.budget.maxModelCalls,
        }
      }

      return {
        ok: true,
        counted: true,
        used: result.run.budget.used,
        maxModelCalls: result.run.budget.maxModelCalls,
      }
    })
  }

  export function attribution(session: AttributionSource): Attribution | undefined {
    if (session.workflowRun) {
      return { runID: session.workflowRun.runID, role: session.workflowRun.role }
    }
    if (session.cortex?.owner?.kind === "workflow_run" && session.cortex.owner.runID) {
      return { runID: session.cortex.owner.runID, role: "contractor" }
    }
    return undefined
  }
}
