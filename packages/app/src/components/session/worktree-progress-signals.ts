import { createSignal } from "solid-js"

export type WorktreeTransitionState = {
  mode: "enter" | "leave"
  sessionID: string
  directory: string
}

export const [worktreeTransition, setWorktreeTransition] = createSignal<WorktreeTransitionState | null>(null)

export function clearWorktreeTransition() {
  setWorktreeTransition(null)
}
