import { LatticeAction } from "../lattice/action"
import { LatticeActionService } from "../lattice/action-service"
import { LatticeError } from "../lattice/error"
import { LatticeTypes } from "../lattice/types"
import { ScopeContext } from "../scope/context"
import { ToolDiagnosticError } from "./diagnostic"
import DESCRIPTION from "./lattice-submit.txt"
import { Tool } from "./tool"

function currentStep(run: LatticeTypes.Run) {
  return (
    run.pathway.find((step) => step.id === run.currentStepID) ??
    run.pathway.find((step) => step.status === "current" || step.status === "executing")
  )
}

function stateConflictDiagnostic(
  error: InstanceType<typeof LatticeError.StateConflict>,
  input: LatticeAction.Input,
): ToolDiagnosticError {
  const expected = LatticeActionService.expectedState(input.action)
  const parsedState = LatticeTypes.State.safeParse(error.data.state)
  const validAction = parsedState.success ? LatticeActionService.validAction(parsedState.data) : undefined
  const pendingConflict = error.data.reason.includes("already pending")
  const inactiveRun = error.data.reason.startsWith("run is ")
  const blueprintUnavailable = error.data.reason.includes("Blueprint") && error.data.reason.includes("unavailable")
  const staleBlueprintReview = error.data.reason.includes("changed after review")
  const retryable = blueprintUnavailable && input.action === "submit_blueprint"
  const instruction = pendingConflict
    ? "A different Lattice action is already durably pending. Do not replace it, poll for it, or submit another action. End this assistant turn so the host can consume the pending action."
    : inactiveRun
      ? "The Lattice Run is not active. Do not retry or continue workflow work. Wait for the user or host to resume, repair, or replace the Run."
      : staleBlueprintReview
        ? "The Blueprint changed after review, so the prior approval is stale. No execution was approved. Do not retry approval or execute the Blueprint. End this turn and let the host return the Step to Blueprint review."
        : retryable
          ? "The requested Blueprint note is unavailable. Stay in the current blueprinting responsibility, locate or repair the intended Blueprint note, then retry submit_blueprint once with its real note ID. Do not execute the Blueprint."
          : `Do not retry this action in the current state. Follow only the responsibility for state "${error.data.state}"${validAction ? `; after that responsibility is complete, its valid action is "${validAction}"` : ""}. Do not bypass Lattice by creating future artifacts, editing project files, or starting a later Pathway Step.`
  const requiredAgentAction = pendingConflict
    ? "end_turn"
    : inactiveRun
      ? "wait_for_run_recovery"
      : staleBlueprintReview
        ? "end_turn_and_wait_for_blueprint_review"
        : retryable
          ? "repair_current_artifact_then_retry_once"
          : "follow_current_state"

  return new ToolDiagnosticError({
    code: retryable ? "invalid_arguments" : "tool_unavailable",
    toolName: "lattice_submit",
    message: JSON.stringify(
      {
        ok: false,
        code: pendingConflict
          ? "LATTICE_ACTION_CONFLICT"
          : inactiveRun
            ? "LATTICE_RUN_NOT_ACTIVE"
            : staleBlueprintReview
              ? "LATTICE_BLUEPRINT_REVIEW_STALE"
              : retryable
                ? "LATTICE_BLUEPRINT_UNAVAILABLE"
                : "LATTICE_ACTION_WRONG_STATE",
        submitted: false,
        action: input.action,
        currentState: error.data.state,
        requiredState: expected,
        validActionForCurrentState: validAction ?? null,
        reason: error.data.reason,
        retryable,
        requiredAgentAction,
        instruction,
      },
      null,
      2,
    ),
    metadata: {
      submitted: false,
      action: input.action,
      currentState: error.data.state,
      requiredState: expected,
      validActionForCurrentState: validAction,
      retryable,
      requiredAgentAction,
    },
  })
}

export const LatticeSubmitTool = Tool.define("lattice_submit", {
  description: DESCRIPTION,
  parameters: LatticeAction.ToolInput,
  formatValidationError(error) {
    return [
      "LATTICE_SUBMIT_INVALID_ARGUMENTS",
      "No Lattice action was submitted or persisted.",
      ...error.issues.map((issue) => issue.message),
      "Use exactly one action contract:",
      LatticeAction.inputContractSummary(),
      "Correct only the arguments for the current Lattice responsibility and retry once. Do not switch actions, advance the workflow yourself, or implement a later state.",
    ].join("\n")
  },
  async execute(params, ctx) {
    const input = LatticeAction.parseToolInput(params)
    const result = await LatticeActionService.submitWithResult({
      scopeID: ScopeContext.current.scope.id,
      sessionID: ctx.sessionID,
      source: "agent",
      input,
    }).catch((error) => {
      if (error instanceof LatticeError.StateConflict) throw stateConflictDiagnostic(error, input)
      if (error instanceof LatticeError.NotFound) {
        throw new ToolDiagnosticError({
          code: "tool_unavailable",
          toolName: "lattice_submit",
          message: JSON.stringify(
            {
              ok: false,
              code: "LATTICE_RUN_NOT_FOUND",
              submitted: false,
              action: input.action,
              retryable: false,
              requiredAgentAction: "wait_for_lattice_run",
              instruction:
                "No active Lattice Run owns this session. Do not retry, create workflow artifacts, or execute work as a substitute. Wait for the host or user to start or restore Lattice.",
            },
            null,
            2,
          ),
          metadata: { submitted: false, action: input.action, retryable: false },
        })
      }
      throw error
    })
    const run = result.run
    const step = currentStep(run)
    const duplicate = result.disposition === "already_queued"
    const instruction = duplicate
      ? "This exact semantic action was already durably queued. End this assistant turn now. Do not call tools, poll state, resubmit, or begin the next Lattice state; the host will consume the existing action after the turn ends."
      : "The semantic action is durably queued. End this assistant turn now. Do not call tools, poll state, resubmit, or begin the next Lattice state; the host owns validation, transition, and delivery after the turn ends."

    return {
      title: duplicate ? `Lattice action already queued: ${input.action}` : `Lattice action queued: ${input.action}`,
      output: JSON.stringify(
        {
          ok: true,
          code: duplicate ? "LATTICE_ACTION_ALREADY_QUEUED" : "LATTICE_ACTION_QUEUED",
          action: input.action,
          persisted: true,
          pending: true,
          disposition: result.disposition,
          state: {
            current: run.state,
            changedSynchronously: false,
            transitionOwner: "lattice_host",
            advancesAfterAssistantTurn: true,
          },
          currentStep: step ? { id: step.id, title: step.title, status: step.status } : null,
          requiredAgentAction: {
            kind: "end_turn",
            instruction,
          },
          prohibitedActions: [
            "Do not call tools after this result.",
            "Do not poll pathway_read or any session state.",
            "Do not resubmit this or another Lattice action.",
            "Do not create artifacts or execute work for the next state or a future Pathway Step.",
          ],
        },
        null,
        2,
      ),
      metadata: {
        runID: run.id,
        state: run.state,
        status: run.status,
        action: input.action,
        source: "agent",
        disposition: result.disposition,
        stateTransitionPending: true,
        requiredAgentAction: "end_turn",
      },
    }
  },
})
