import z from "zod"
import { Identifier } from "../id/id"

export namespace LatticeTypes {
  export const SCHEMA_VERSION = 2 as const

  export const Mode = z.enum(["auto", "collaborative"])
  export type Mode = z.infer<typeof Mode>

  export const State = z.enum([
    "clarifying",
    "planning",
    "reviewing_pathway",
    "blueprinting",
    "reviewing_blueprint",
    "awaiting_execution",
    "executing",
  ])
  export type State = z.infer<typeof State>

  /** @deprecated Use State. Kept as a type-level transition aid for callers moving off v1. */
  export const Phase = State
  /** @deprecated Use State. */
  export type Phase = State

  export const RunStatus = z.enum(["active", "paused", "completed", "failed", "cancelled"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const StepStatus = z.enum(["pending", "current", "executing", "completed", "failed", "cancelled"])
  export type StepStatus = z.infer<typeof StepStatus>

  export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"]
  export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ["completed", "failed", "cancelled"]

  export function isTerminalRun(status: RunStatus): boolean {
    return TERMINAL_RUN_STATUSES.includes(status)
  }

  export function isTerminalStep(status: StepStatus): boolean {
    return TERMINAL_STEP_STATUSES.includes(status)
  }

  const RunTime = z
    .object({
      created: z.number(),
      updated: z.number(),
      paused: z.number().optional(),
      completed: z.number().optional(),
    })
    .strict()

  const StepTime = z
    .object({
      created: z.number(),
      updated: z.number(),
      started: z.number().optional(),
      completed: z.number().optional(),
    })
    .strict()

  const ActionTime = z.object({ created: z.number() }).strict()
  const EffectTime = z.object({ created: z.number() }).strict()

  export const Requirements = z
    .object({
      goal: z.string().trim().min(1),
      successCriteria: z.array(z.string().trim().min(1)).min(1),
      constraints: z.array(z.string().trim().min(1)),
      nonGoals: z.array(z.string().trim().min(1)),
      assumptions: z.array(z.string().trim().min(1)),
    })
    .strict()
    .meta({ ref: "LatticeRequirements" })
  export type Requirements = z.infer<typeof Requirements>

  export const BlueprintBinding = z
    .object({
      noteID: z.string().min(1),
      boundVersion: z.number().int().min(0),
      contentDigest: z.string().min(1),
      reviewedVersion: z.number().int().min(0).optional(),
      reviewedContentDigest: z.string().min(1).optional(),
      time: z
        .object({
          bound: z.number(),
          reviewed: z.number().optional(),
        })
        .strict(),
    })
    .strict()
    .meta({ ref: "LatticeBlueprintBinding" })
  export type BlueprintBinding = z.infer<typeof BlueprintBinding>

  export const LoopAttemptStatus = z.enum(["created", "running", "completed", "failed", "cancelled"])
  export type LoopAttemptStatus = z.infer<typeof LoopAttemptStatus>

  export const LoopAttempt = z
    .object({
      loopID: Identifier.schema("blueprint_loop"),
      status: LoopAttemptStatus,
      sourceDigest: z.string().min(1),
      summary: z.string().optional(),
      error: z.string().optional(),
      time: z
        .object({
          created: z.number(),
          started: z.number().optional(),
          completed: z.number().optional(),
        })
        .strict(),
    })
    .strict()
    .meta({ ref: "LatticeLoopAttempt" })
  export type LoopAttempt = z.infer<typeof LoopAttempt>

  export const Step = z
    .object({
      id: Identifier.schema("lattice_step"),
      title: z.string().trim().min(1),
      objective: z.string().trim().min(1),
      status: StepStatus,
      acceptanceCriteria: z.array(z.string().trim().min(1)),
      assumptions: z.array(z.string().trim().min(1)),
      addressesFailedStepIDs: z.array(Identifier.schema("lattice_step")).optional(),
      blueprint: BlueprintBinding.optional(),
      blueprintHistory: z.array(BlueprintBinding),
      loopHistory: z.array(LoopAttempt),
      resultSummary: z.string().optional(),
      failureReason: z.string().optional(),
      resultCommit: z.string().optional(),
      worktreeID: z.string().optional(),
      time: StepTime,
    })
    .strict()
    .meta({ ref: "LatticeStep" })
  export type Step = z.infer<typeof Step>

  const ActionBase = {
    id: Identifier.schema("lattice_action"),
    source: z.enum(["agent", "panel"]),
    expectedStateRevision: z.number().int().min(0),
    expectedPathwayRevision: z.number().int().min(0),
    time: ActionTime,
  }

  export const SubmitRequirementsAction = z
    .object({
      ...ActionBase,
      kind: z.literal("submit_requirements"),
      requirements: Requirements,
    })
    .strict()
  export type SubmitRequirementsAction = z.infer<typeof SubmitRequirementsAction>

  export const SubmitPathwayAction = z
    .object({
      ...ActionBase,
      kind: z.literal("submit_pathway"),
      reason: z.string().trim().min(1),
    })
    .strict()
  export type SubmitPathwayAction = z.infer<typeof SubmitPathwayAction>

  export const SubmitPathwayReviewAction = z
    .object({
      ...ActionBase,
      kind: z.literal("submit_pathway_review"),
      reason: z.string().trim().min(1),
    })
    .strict()
  export type SubmitPathwayReviewAction = z.infer<typeof SubmitPathwayReviewAction>

  export const SubmitBlueprintAction = z
    .object({
      ...ActionBase,
      kind: z.literal("submit_blueprint"),
      blueprintID: z.string().min(1),
      blueprintVersion: z.number().int().min(0),
      contentDigest: z.string().min(1),
    })
    .strict()
  export type SubmitBlueprintAction = z.infer<typeof SubmitBlueprintAction>

  export const SubmitBlueprintReviewAction = z
    .object({
      ...ActionBase,
      kind: z.literal("submit_blueprint_review"),
      reason: z.string().trim().min(1),
      blueprintVersion: z.number().int().min(0),
      contentDigest: z.string().min(1),
    })
    .strict()
  export type SubmitBlueprintReviewAction = z.infer<typeof SubmitBlueprintReviewAction>

  export const ApproveExecutionAction = z
    .object({
      ...ActionBase,
      kind: z.literal("approve_execution"),
      reason: z.string().trim().min(1),
      blueprintVersion: z.number().int().min(0),
      contentDigest: z.string().min(1),
    })
    .strict()
  export type ApproveExecutionAction = z.infer<typeof ApproveExecutionAction>

  export const PendingAction = z
    .discriminatedUnion("kind", [
      SubmitRequirementsAction,
      SubmitPathwayAction,
      SubmitPathwayReviewAction,
      SubmitBlueprintAction,
      SubmitBlueprintReviewAction,
      ApproveExecutionAction,
    ])
    .meta({ ref: "LatticePendingAction" })
  export type PendingAction = z.infer<typeof PendingAction>

  const EffectBase = {
    id: Identifier.schema("lattice_effect"),
    time: EffectTime,
  }

  export const PromptEffect = z
    .object({
      ...EffectBase,
      kind: z.literal("deliver_prompt"),
      promptType: z.enum(["state_entry", "resume", "repair"]),
      state: State,
      deliveryKey: z.string().min(1),
      deliveredMessageID: Identifier.schema("message").optional(),
      validationErrors: z.array(z.string().min(1)).optional(),
      attemptCount: z.number().int().min(0).default(0),
    })
    .strict()
  export type PromptEffect = z.infer<typeof PromptEffect>

  export const CreateBlueprintLoopEffect = z
    .object({
      ...EffectBase,
      kind: z.literal("create_blueprint_loop"),
      stepID: Identifier.schema("lattice_step"),
      blueprintNoteID: z.string().min(1),
      blueprintVersion: z.number().int().min(0),
      sourceDigest: z.string().min(1),
    })
    .strict()
  export type CreateBlueprintLoopEffect = z.infer<typeof CreateBlueprintLoopEffect>

  export const StartBlueprintLoopEffect = z
    .object({
      ...EffectBase,
      kind: z.literal("start_blueprint_loop"),
      stepID: Identifier.schema("lattice_step"),
      loopID: Identifier.schema("blueprint_loop"),
      blueprintVersion: z.number().int().min(0),
      sourceDigest: z.string().min(1),
    })
    .strict()
  export type StartBlueprintLoopEffect = z.infer<typeof StartBlueprintLoopEffect>

  export const Effect = z
    .discriminatedUnion("kind", [PromptEffect, CreateBlueprintLoopEffect, StartBlueprintLoopEffect])
    .meta({ ref: "LatticeEffect" })
  export type Effect = z.infer<typeof Effect>

  export const Run = z
    .object({
      schemaVersion: z.literal(SCHEMA_VERSION),
      id: Identifier.schema("lattice_run"),
      scopeID: z.string().min(1),
      sessionID: Identifier.schema("session"),
      mode: Mode,
      maxModelCalls: z.number().int().min(0),
      modelCallCount: z.number().int().min(0),
      status: RunStatus,
      statusReason: z.string().optional(),
      state: State,
      goalSeed: z.string().optional(),
      requirements: Requirements.optional(),
      currentStepID: Identifier.schema("lattice_step").optional(),
      revision: z.number().int().min(0),
      stateRevision: z.number().int().min(0),
      pathwayRevision: z.number().int().min(0),
      pathway: z.array(Step),
      pendingAction: PendingAction.optional(),
      effect: Effect.optional(),
      time: RunTime,
    })
    .strict()
    .meta({ ref: "LatticeRun" })
  export type Run = z.infer<typeof Run>

  export const CurrentPointer = z
    .object({
      schemaVersion: z.literal(SCHEMA_VERSION),
      scopeID: z.string().min(1),
      sessionID: Identifier.schema("session"),
      runID: Identifier.schema("lattice_run"),
      time: z.object({ created: z.number(), updated: z.number() }).strict(),
    })
    .strict()
    .meta({ ref: "LatticeCurrentPointer" })
  export type CurrentPointer = z.infer<typeof CurrentPointer>

  const BlueprintBindingView = BlueprintBinding.omit({ contentDigest: true, reviewedContentDigest: true })
    .strict()
    .meta({ ref: "LatticeBlueprintBindingView" })

  const LoopAttemptView = LoopAttempt.omit({ sourceDigest: true }).strict().meta({ ref: "LatticeLoopAttemptView" })

  export const StepView = Step.omit({ blueprint: true, blueprintHistory: true, loopHistory: true })
    .extend({
      blueprint: BlueprintBindingView.optional(),
      blueprintHistory: z.array(BlueprintBindingView),
      loopHistory: z.array(LoopAttemptView),
    })
    .strict()
    .meta({ ref: "LatticeStepView" })
  export type StepView = z.infer<typeof StepView>

  export const RunView = Run.omit({ pendingAction: true, effect: true, pathway: true })
    .extend({ pathway: z.array(StepView) })
    .strict()
    .meta({ ref: "LatticeRunView" })
  export type RunView = z.infer<typeof RunView>

  export function toRunView(run: Run): RunView {
    return RunView.parse({
      schemaVersion: run.schemaVersion,
      id: run.id,
      scopeID: run.scopeID,
      sessionID: run.sessionID,
      mode: run.mode,
      maxModelCalls: run.maxModelCalls,
      modelCallCount: run.modelCallCount,
      status: run.status,
      statusReason: run.statusReason,
      state: run.state,
      goalSeed: run.goalSeed,
      requirements: run.requirements,
      currentStepID: run.currentStepID,
      revision: run.revision,
      stateRevision: run.stateRevision,
      pathwayRevision: run.pathwayRevision,
      pathway: run.pathway.map((step) => ({
        id: step.id,
        title: step.title,
        objective: step.objective,
        status: step.status,
        acceptanceCriteria: step.acceptanceCriteria,
        assumptions: step.assumptions,
        addressesFailedStepIDs: step.addressesFailedStepIDs,
        blueprint: step.blueprint && {
          noteID: step.blueprint.noteID,
          boundVersion: step.blueprint.boundVersion,
          reviewedVersion: step.blueprint.reviewedVersion,
          time: step.blueprint.time,
        },
        blueprintHistory: step.blueprintHistory.map((binding) => ({
          noteID: binding.noteID,
          boundVersion: binding.boundVersion,
          reviewedVersion: binding.reviewedVersion,
          time: binding.time,
        })),
        loopHistory: step.loopHistory.map((attempt) => ({
          loopID: attempt.loopID,
          status: attempt.status,
          summary: attempt.summary,
          error: attempt.error,
          time: attempt.time,
        })),
        resultSummary: step.resultSummary,
        failureReason: step.failureReason,
        resultCommit: step.resultCommit,
        worktreeID: step.worktreeID,
        time: step.time,
      })),
      time: run.time,
    })
  }

  export const EventKind = z.enum([
    "run_created",
    "run_updated",
    "state_changed",
    "pathway_replaced",
    "action_submitted",
    "action_consumed",
    "step_blueprint_bound",
    "step_started",
    "step_completed",
    "step_failed",
    "step_cancelled",
    "loop_cancelled",
    "run_paused",
    "run_resumed",
    "run_completed",
    "run_failed",
    "run_cancelled",
    "budget_exhausted",
    "recovery_reconciled",
  ])
  export type EventKind = z.infer<typeof EventKind>

  export const EventInfo = z
    .object({
      id: Identifier.schema("lattice_event"),
      runID: Identifier.schema("lattice_run"),
      scopeID: z.string().min(1),
      sessionID: Identifier.schema("session"),
      kind: EventKind,
      stepID: Identifier.schema("lattice_step").optional(),
      state: State.optional(),
      message: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      time: z.object({ created: z.number() }).strict(),
    })
    .strict()
    .meta({ ref: "LatticeEvent" })
  export type EventInfo = z.infer<typeof EventInfo>
}
