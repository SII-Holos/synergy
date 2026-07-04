import { createSignal } from "solid-js"
import type { SessionStartProgress } from "./worktree-transition-dialog"

/**
 * Module-level signals used by multiple components to coordinate
 * session-scoped loading / progress UI without global dialogs.
 *
 * Both signals are read by session.tsx and written by submit.ts and
 * session-top-bar.tsx.
 */

export const [newSessionProgress, setNewSessionProgress] = createSignal<SessionStartProgress | null>(null)

export function clearNewSessionProgress() {
  setNewSessionProgress(null)
}

export type WorktreeTransitionState = {
  mode: "enter" | "leave"
  sessionID: string
  directory: string
}

export const [worktreeTransition, setWorktreeTransition] = createSignal<WorktreeTransitionState | null>(null)

export function clearWorktreeTransition() {
  setWorktreeTransition(null)
}
