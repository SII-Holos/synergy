import type { MessageDescriptor } from "@lingui/core"
import type { BlueprintLoopInfo, LatticeRunView as GeneratedLatticeRunView } from "@ericsanchezok/synergy-sdk/client"

export type LatticeRunView = GeneratedLatticeRunView
export type LatticeMode = LatticeRunView["mode"]
export type LatticeWorkState = LatticeRunView["state"]
export type LatticeStepStatus = LatticeRunView["pathway"][number]["status"]
export type LatticeLoopView = Pick<
  BlueprintLoopInfo,
  "id" | "title" | "sessionID" | "source" | "status" | "summary" | "time"
>

export type LatticeActionTarget = {
  generation: number
  sessionID: string
  runID: string
}

const WORK_STATE_DESCRIPTORS = {
  clarifying: { id: "app.lattice.state.clarifying", message: "Understanding" },
  planning: { id: "app.lattice.state.planning", message: "Planning" },
  reviewing_pathway: { id: "app.lattice.state.reviewingPathway", message: "Reviewing Pathway" },
  blueprinting: { id: "app.lattice.state.blueprinting", message: "Designing Blueprint" },
  reviewing_blueprint: { id: "app.lattice.state.reviewingBlueprint", message: "Reviewing Blueprint" },
  awaiting_execution: { id: "app.lattice.state.awaitingExecution", message: "Waiting for You" },
  executing: { id: "app.lattice.state.executing", message: "Executing" },
} satisfies Record<LatticeWorkState, MessageDescriptor>

export const RUN_STATUS_DESCRIPTORS = {
  active: { id: "app.lattice.status.active", message: "Active" },
  paused: { id: "app.lattice.status.paused", message: "Paused" },
  completed: { id: "app.lattice.status.completed", message: "Completed" },
  failed: { id: "app.lattice.status.failed", message: "Failed" },
  cancelled: { id: "app.lattice.status.cancelled", message: "Cancelled" },
} satisfies Record<LatticeRunView["status"], MessageDescriptor>

export const STEP_STATUS_DESCRIPTORS = {
  pending: { id: "app.lattice.step.pending", message: "Pending" },
  current: { id: "app.lattice.step.current", message: "Current" },
  executing: { id: "app.lattice.step.executing", message: "Executing" },
  completed: { id: "app.lattice.step.completed", message: "Completed" },
  failed: { id: "app.lattice.step.failed", message: "Failed" },
  cancelled: { id: "app.lattice.step.cancelled", message: "Cancelled" },
} satisfies Record<LatticeStepStatus, MessageDescriptor>

export const LOOP_STATUS_DESCRIPTORS = {
  armed: { id: "app.lattice.loop.armed", message: "Ready" },
  running: { id: "app.lattice.loop.running", message: "Running" },
  waiting: { id: "app.lattice.loop.waiting", message: "Waiting" },
  auditing: { id: "app.lattice.loop.auditing", message: "Reviewing" },
  completed: { id: "app.lattice.loop.completed", message: "Completed" },
  failed: { id: "app.lattice.loop.failed", message: "Failed" },
  cancelled: { id: "app.lattice.loop.cancelled", message: "Cancelled" },
} satisfies Record<LatticeLoopView["status"], MessageDescriptor>

const PAUSE_REASON_DESCRIPTORS: Record<string, MessageDescriptor> = {
  user_paused: { id: "app.lattice.reason.userPause", message: "Paused by you" },
  user_exit: { id: "app.lattice.reason.userExit", message: "Exited by you" },
  turn_interrupted: { id: "app.lattice.reason.turnInterrupted", message: "Model turn interrupted" },
  model_turn_interrupted: { id: "app.lattice.reason.turnInterrupted", message: "Model turn interrupted" },
  model_error: { id: "app.lattice.reason.modelError", message: "Model turn failed" },
  model_call_budget_exhausted: { id: "app.lattice.reason.budget", message: "Model-call budget reached" },
  blueprint_loop_failed: { id: "app.lattice.reason.loopFailed", message: "BlueprintLoop failed" },
  blueprint_loop_cancelled: { id: "app.lattice.reason.loopCancelled", message: "BlueprintLoop was cancelled" },
}

type Translate = (descriptor: MessageDescriptor) => string

export function workStateDescriptor(state: LatticeWorkState): MessageDescriptor {
  return WORK_STATE_DESCRIPTORS[state]
}

export function workStateLabel(translate: Translate, state: LatticeWorkState): string {
  return translate(WORK_STATE_DESCRIPTORS[state])
}

export function pauseReasonDescriptor(reason?: string): MessageDescriptor {
  return reason && PAUSE_REASON_DESCRIPTORS[reason]
    ? PAUSE_REASON_DESCRIPTORS[reason]
    : { id: "app.lattice.reason.attention", message: "Paused and ready to resume" }
}

export function pauseReasonLabel(translate: Translate, reason?: string): string {
  return translate(pauseReasonDescriptor(reason))
}

export function runWorkState(run: LatticeRunView): LatticeWorkState {
  return run.state
}

export function selectFresherRun(
  current: LatticeRunView | null,
  incoming: LatticeRunView | null,
): LatticeRunView | null {
  if (!incoming) return current
  if (!current) return incoming
  if (current.id === incoming.id) return incoming.revision >= current.revision ? incoming : current
  if (incoming.time.created !== current.time.created) {
    return incoming.time.created > current.time.created ? incoming : current
  }
  if (incoming.id !== current.id) return incoming.id.localeCompare(current.id) > 0 ? incoming : current
  return incoming.time.updated >= current.time.updated ? incoming : current
}

export function isCurrentLatticeActionTarget(
  target: LatticeActionTarget,
  current: { generation: number; sessionID: string; runID?: string },
): boolean {
  return (
    target.generation === current.generation && target.sessionID === current.sessionID && target.runID === current.runID
  )
}

export function controlsForRun(run: LatticeRunView) {
  const active = run.status === "active"
  return {
    pause: active,
    resume: run.status === "paused" || (active && run.state !== "executing" && run.state !== "awaiting_execution"),
    cancel: active || run.status === "paused",
    approve: active && run.mode === "collaborative" && run.state === "awaiting_execution",
  }
}

export function referencedLoopIDs(run: LatticeRunView): Set<string> {
  return new Set(run.pathway.flatMap((step) => step.loopHistory.map((attempt) => attempt.loopID)))
}

export function isLatticeConflict(error: unknown): boolean {
  if (error instanceof Error && error.name === "APIError") {
    const data = (error as { data?: { statusCode?: number } }).data
    return data?.statusCode === 409
  }
  if (!error || typeof error !== "object") return false
  const body = error as { message?: unknown; data?: unknown }
  if (typeof body.message !== "string" || !body.data || typeof body.data !== "object") return false
  const data = body.data as { state?: unknown; reason?: unknown }
  return typeof data.state === "string" && typeof data.reason === "string" && data.reason.trim().length > 0
}

export function shouldDismissCancelConfirmation(key: string): boolean {
  return key === "Escape"
}
