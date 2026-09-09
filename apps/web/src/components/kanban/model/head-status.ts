import type { SessionVisualState } from "@/components/sidebar/session-visual-state"

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
    case "blueprint-audit":
      if (input.pulse) return "working"
      break
    case "active":
    case "blueprint-running":
      return "working"
    default:
      break
  }
  // Recovering is not surfaced as "active" by the sidebar visual resolution
  // (it counts as idle there), but on the board it is still live work and
  // should read as working rather than completed or idle.
  if (input.statusType === "busy" || input.statusType === "retry" || input.statusType === "recovering") {
    return "working"
  }
  return input.completionUnread ? "completed" : undefined
}
