import z from "zod"
import { Identifier } from "../id/id"

export namespace LatticeTypes {
  export const Mode = z.enum(["auto", "collaborative"])
  export type Mode = z.infer<typeof Mode>

  export const Phase = z.enum([
    "initial_planning",
    "step_blueprinting",
    "blueprint_review",
    "blueprint_execution",
    "result_analysis",
  ])
  export type Phase = z.infer<typeof Phase>

  export const RunStatus = z.enum(["active", "paused", "completed", "failed", "cancelled"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const StepStatus = z.enum([
    "pending",
    "ready",
    "blueprinting",
    "reviewing",
    "running",
    "completed",
    "failed",
    "blocked",
    "cancelled",
  ])
  export type StepStatus = z.infer<typeof StepStatus>

  /** Steps that can no longer be edited or reordered. */
  export const TERMINAL_STEP_STATUSES: StepStatus[] = ["completed", "failed", "cancelled"]

  export function isTerminalStep(status: StepStatus): boolean {
    return TERMINAL_STEP_STATUSES.includes(status)
  }

  export const Step = z
    .object({
      id: Identifier.schema("lattice_step"),
      title: z.string(),
      objective: z.string(),
      status: StepStatus,
      acceptanceCriteria: z.array(z.string()).default([]),
      assumptions: z.array(z.string()).default([]),
      blueprintNoteID: z.string().optional(),
      blueprintVersion: z.number().optional(),
      blueprintLoopID: Identifier.schema("blueprint_loop").optional(),
      resultSummary: z.string().optional(),
      failureReason: z.string().optional(),
      resultCommit: z.string().optional(),
      worktreeID: z.string().optional(),
      addressesFailedStepIDs: z.array(Identifier.schema("lattice_step")).optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        started: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "LatticeStep" })
  export type Step = z.infer<typeof Step>

  export const Run = z
    .object({
      id: Identifier.schema("lattice_run"),
      scopeID: z.string(),
      sessionID: Identifier.schema("session"),
      mode: Mode,
      maxModelCalls: z.number().int().min(0).default(0),
      modelCallCount: z.number().int().min(0).default(0),
      status: RunStatus,
      statusReason: z.string().optional(),
      phase: Phase,
      goal: z.string().optional(),
      currentStepID: Identifier.schema("lattice_step").optional(),
      firstBlueprintStarted: z.boolean().default(false),
      assumptions: z.array(z.string()).default([]),
      pathway: z.array(Step).default([]),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        paused: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "LatticeRun" })
  export type Run = z.infer<typeof Run>

  export const EventKind = z.enum([
    "run_created",
    "run_updated",
    "phase_changed",
    "step_added",
    "step_updated",
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
  ])
  export type EventKind = z.infer<typeof EventKind>

  export const EventInfo = z
    .object({
      id: Identifier.schema("lattice_event"),
      runID: Identifier.schema("lattice_run"),
      scopeID: z.string(),
      sessionID: Identifier.schema("session"),
      kind: EventKind,
      stepID: Identifier.schema("lattice_step").optional(),
      phase: Phase.optional(),
      message: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      time: z.object({ created: z.number() }),
    })
    .meta({ ref: "LatticeEvent" })
  export type EventInfo = z.infer<typeof EventInfo>
}
