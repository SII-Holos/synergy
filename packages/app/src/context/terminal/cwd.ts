import type { Session } from "@ericsanchezok/synergy-sdk/client"

/**
 * Resolve the terminal CWD from a session's workspace binding.
 *
 * Returns the workspace path when the session is bound to a git worktree
 * (or any non-"main" workspace type). Returns undefined otherwise, which
 * causes the terminal to fall through to the server default (scope directory).
 *
 * This mirrors the workspace-tracking pattern used by the status bar:
 * `session.workspace` is kept accurate by the global sync SSE handler via
 * `resolveWorkspaceTransition` in workspace-transition.ts.
 */
export function resolveTerminalCwd(session: Session | undefined): string | undefined {
  const ws = session?.workspace
  if (!ws) return undefined
  if (ws.type === "main") return undefined
  if (!ws.path) return undefined
  return ws.path
}
