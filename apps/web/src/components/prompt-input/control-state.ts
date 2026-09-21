import type { SessionActivity } from "@/utils/session-status"

/**
 * The composer's single primary control. Its meaning follows session state, so
 * there is one button where a workflow icon slot and a separate stop button
 * used to sit — and no state can leave a session with two contradictory
 * affordances.
 */
export type PromptControlState = "send" | "pause" | "continue" | "disabled"

/** The long-press gesture is destructive (cancel a bound workflow, terminalize
 *  the turn) with no confirmation dialog, so the ring is the only confirmation
 *  and the threshold has to survive an accidental press during scroll. */
export const ABANDON_HOLD_MS = 3000

/** Pointer travel that turns a hold into a drag or a scroll. */
export const ABANDON_HOLD_TOLERANCE_PX = 8

export function resolvePromptControlState(input: {
  hasDraft: boolean
  activity: SessionActivity
  /** An armed BlueprintLoop (or other pending workflow) whose start is a send. */
  hasArmedWorkflow: boolean
}): PromptControlState {
  // A draft always means "send": the text in the box is the user's explicit
  // intent, and sending new input is also how a paused session resumes.
  if (input.hasDraft) return "send"
  if (input.activity === "working") return "pause"
  if (input.activity === "paused") return "continue"
  if (input.hasArmedWorkflow) return "send"
  return "disabled"
}

/**
 * Whether long-press is armed. An empty idle composer has no control action, so
 * the only gesture available is abandoning a bound workflow — and with nothing
 * bound there is nothing to abandon.
 */
export function canLongPressAbandon(input: {
  hasDraft: boolean
  activity: SessionActivity
  hasBoundWorkflow: boolean
}): boolean {
  if (input.activity === "working" || input.activity === "paused") return true
  return input.hasBoundWorkflow
}
