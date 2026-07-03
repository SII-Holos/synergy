export type NewSessionWorkspaceSelection =
  | { mode: "current" }
  | { mode: "create" }
  | { mode: "existing"; target: string }

export type WorkspaceChangeStatus = { type?: string } | undefined

export function normalizePathForCompare(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.toLowerCase()
}

function isWorktreeDirectory(currentDirectory?: string, canonicalDirectory?: string) {
  if (!currentDirectory || !canonicalDirectory) return false
  return normalizePathForCompare(currentDirectory) !== normalizePathForCompare(canonicalDirectory)
}

export function defaultNewSessionWorkspaceSelection(input: {
  selected?: NewSessionWorkspaceSelection
  currentDirectory?: string
  canonicalDirectory?: string
}): NewSessionWorkspaceSelection {
  if (input.selected) return input.selected
  if (isWorktreeDirectory(input.currentDirectory, input.canonicalDirectory) && input.currentDirectory) {
    return { mode: "existing", target: input.currentDirectory }
  }
  return { mode: "current" }
}

export function worktreeOptionSelection(input: {
  currentDirectory?: string
  canonicalDirectory?: string
}): NewSessionWorkspaceSelection {
  if (isWorktreeDirectory(input.currentDirectory, input.canonicalDirectory) && input.currentDirectory) {
    return { mode: "existing", target: input.currentDirectory }
  }
  return { mode: "create" }
}

export function isWorktreeWorkspaceSelection(selection: NewSessionWorkspaceSelection) {
  return selection.mode === "create" || selection.mode === "existing"
}

export function isSessionRunningForWorkspaceChange(input: {
  pending?: boolean
  status?: WorkspaceChangeStatus
  working?: unknown
}) {
  if (input.pending) return true
  if (input.working) return true
  if (!input.status) return false
  return input.status.type !== undefined && input.status.type !== "idle"
}

export type WorkspaceTransitionOperation = "enter" | "leave" | "start"
export type WorkspaceTransitionPhase = "idle" | "form" | "loading" | "success" | "error"

export type WorkspaceTransitionProgressState =
  | { phase: "idle" }
  | { phase: "form"; operation: WorkspaceTransitionOperation }
  | { phase: "loading"; operation: WorkspaceTransitionOperation; step: string }
  | { phase: "success"; operation: WorkspaceTransitionOperation; message?: string }
  | { phase: "error"; operation: WorkspaceTransitionOperation; message: string }

export type WorkspaceTransitionProgressAction =
  | { type: "open"; operation: WorkspaceTransitionOperation }
  | { type: "load"; operation?: WorkspaceTransitionOperation; step: string }
  | { type: "succeed"; message?: string }
  | { type: "fail"; message: string }
  | { type: "reset" }

export function reduceWorkspaceTransitionProgress(
  state: WorkspaceTransitionProgressState,
  action: WorkspaceTransitionProgressAction,
): WorkspaceTransitionProgressState {
  if (action.type === "reset") return { phase: "idle" }

  if (action.type === "open") {
    if (state.phase === "loading") return state
    return { phase: "form", operation: action.operation }
  }

  if (action.type === "load") {
    if (state.phase === "loading") return state
    const operation = action.operation ?? (state.phase === "idle" ? "start" : state.operation)
    return { phase: "loading", operation, step: action.step }
  }

  if (action.type === "succeed") {
    if (state.phase !== "loading") return state
    return { phase: "success", operation: state.operation, message: action.message }
  }

  if (action.type === "fail") {
    if (state.phase === "idle") return state
    return { phase: "error", operation: state.operation, message: action.message }
  }

  return state
}
