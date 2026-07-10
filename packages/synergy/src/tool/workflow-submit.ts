import z from "zod"
import { Tool } from "./tool"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { WorkflowMachine, WorkflowRunStore, WorkflowTypes } from "../workflow-run"
import { WorkflowToolShared } from "./workflow-shared"
import DESCRIPTION from "./workflow-submit.txt"

const parameters = z.object({
  kind: z
    .enum(["review_verdict", "test_report", "deliverable", "note_ref"])
    .describe("Type of result you are recording."),
  summary: z
    .string()
    .describe("Concise description of the result (review comments, test evidence, what you delivered)."),
  verdict: z.enum(["passed", "changes_requested", "blocked"]).optional().describe("For review/test submissions."),
  refs: z.array(z.string()).optional().describe("References: note ids, commits, PR URLs, session ids."),
  transitionID: z
    .string()
    .optional()
    .describe("The transition this submission satisfies. Omit to record the submission without advancing."),
})

export const WorkflowSubmitTool = Tool.define("workflow_submit", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const { run, seat, entity } = await WorkflowToolShared.requireSeat(ctx.sessionID)
    if (!entity) throw new Error("You have no entity assigned; nothing to submit.")

    const submission: WorkflowTypes.Submission = {
      id: Identifier.ascending("workflow_event"),
      kind: params.kind,
      seat,
      sessionID: ctx.sessionID,
      verdict: params.verdict,
      summary: params.summary,
      refs: params.refs ?? [],
      time: Date.now(),
    }

    if (!params.transitionID) {
      // Record the submission without a transition.
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        const e = draft.entities.find((x) => x.id === entity.id)
        if (e) e.submissions.push(submission)
      })
      await WorkflowRunStore.appendEvent(
        scopeID,
        { id: run.id },
        {
          kind: "submission_recorded",
          entityID: entity.id,
          seat,
          data: { kind: submission.kind, verdict: submission.verdict },
        },
      )
      return {
        title: `Submission recorded (${params.kind})`,
        output: "Recorded without advancing (no transitionID given).",
        metadata: { runID: run.id, entityID: entity.id } as Record<string, any>,
      }
    }

    const result = await WorkflowMachine.submitIntent({
      scopeID,
      runID: run.id,
      entityID: entity.id,
      transitionID: params.transitionID,
      actorSessionID: ctx.sessionID,
      submission,
    })
    if (!result.ok) {
      throw new Error(`Submission rejected: ${result.reason}`)
    }
    return {
      title: `Submitted (${params.kind}) → ${result.entityState}`,
      output: `Entity ${entity.id} advanced to "${result.entityState}".`,
      metadata: { runID: run.id, entityID: entity.id, state: result.entityState } as Record<string, any>,
    }
  },
})
