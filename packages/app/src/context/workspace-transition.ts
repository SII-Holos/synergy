import type { Part, SessionWorkspace } from "@ericsanchezok/synergy-sdk/client"

/** Result of inspecting a completed tool part for a workspace transition. */
export type WorkspaceTransition =
  | { kind: "none" }
  | { kind: "enter"; workspace: Record<string, unknown> }
  | { kind: "leave"; workspace: SessionWorkspace }

/**
 * Determine whether a completed tool part represents a workspace transition.
 * Extracted for testability — the SSE handler calls this and then applies
 * the returned workspace to the session store.
 *
 * The session.updated WebSocket event is the canonical workspace source, but
 * it has delivery latency. This optimistic patch ensures the status bar icon
 * updates synchronously with the visible tool result.
 */
export function resolveWorkspaceTransition(part: Part): WorkspaceTransition {
  if (part.type !== "tool" || part.state.status !== "completed") return { kind: "none" }
  const metadata = part.state.metadata

  if (part.tool === "worktree_enter" && metadata?.action === "entered") {
    const workspace = metadata?.workspace as Record<string, unknown> | undefined
    if (workspace) return { kind: "enter", workspace }
  } else if (part.tool === "worktree_leave" && metadata?.action === "left") {
    const restored = metadata?.restored as { type?: string; path?: string } | undefined
    if (restored && restored.path) {
      return {
        kind: "leave",
        workspace: {
          type: restored.type ?? "main",
          path: restored.path,
          scopeID: "",
        },
      }
    }
  }

  return { kind: "none" }
}
