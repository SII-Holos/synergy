import type { NavEntry } from "@/context/layout"

export type LightLoopControlState =
  | { mode: "editable"; reason: "editable" }
  | { mode: "readOnly"; reason: "inactive" | "reviewPending" | "working" }

/** Whether the backend reports this session's Light Loop as still active. The
 * terminal status set lives only in the backend; a navigation entry carries its
 * answer as `workflow.active`. */
export function isActiveLightLoopNavEntry(entry: NavEntry | undefined): boolean {
  const workflow = entry?.workflow
  return workflow?.kind === "lightloop" && workflow.active
}

/**
 * The composer's Light Loop activity answer.
 *
 * A terminal Light Loop clears the session's workflow record, while both
 * navigation merges treat an absent `workflow` key as "no update" and keep the
 * last projected value, so a retained entry alone can still read active after
 * the loop ended. Require the record to exist as well: it is cleared on every
 * terminal transition, so it is the authoritative terminal signal. A session
 * outside every loaded navigation list has no entry yet, and there the record's
 * presence is the only available answer.
 */
export function resolveLightLoopActivity(input: {
  workflow: { kind?: string } | undefined
  entry: NavEntry | undefined
}): boolean {
  if (input.workflow?.kind !== "lightloop") return false
  if (!input.entry) return true
  return isActiveLightLoopNavEntry(input.entry)
}

export function resolveLightLoopControlState(input: {
  active: boolean
  working: boolean
  reviewPending: boolean
}): LightLoopControlState {
  if (!input.active) return { mode: "readOnly", reason: "inactive" }
  if (input.reviewPending) return { mode: "readOnly", reason: "reviewPending" }
  if (input.working) return { mode: "readOnly", reason: "working" }
  return { mode: "editable", reason: "editable" }
}
