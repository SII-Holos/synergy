import type { SessionVisualState } from "@/components/sidebar/session-visual-state"
import { isWorkingStatus } from "@/utils/session-status"

/**
 * Head-status tint for a Kanban pane, derived from the session's resolved
 * visual state (the same resolution the sidebar rows use) plus the raw
 * session status. Working and waiting win over the completed tint so a pane
 * that is both active and finished reads as what it is doing now, and
 * "waiting for the user" always outranks "busy" because it demands attention.
 */
export type PaneHeadStatus = "working" | "waiting" | "completed" | undefined

export function paneHeadStatusFromVisual(input: {
  statusType?: string
  tone?: SessionVisualState["tone"]
  pulse?: boolean
  completionUnread?: boolean
}): PaneHeadStatus {
  switch (input.tone) {
    case "waiting":
    case "blueprint-waiting":
      return "waiting"
    case "retry":
    case "active":
    case "blueprint-running":
      return "working"
    case "loop":
      if (input.pulse) return "working"
      break
    case "blueprint-audit":
      if (input.pulse) return "working"
      break
    default:
      break
  }
  // The raw status covers a pane whose resolved tone is still resting, so a
  // session that is working must not read as completed or idle.
  if (isWorkingStatus({ type: input.statusType })) return "working"
  return input.completionUnread ? "completed" : undefined
}
