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

export function worktreeSetupFailureMessage(input: { setupFailed?: boolean; setupError?: string } | undefined) {
  if (!input?.setupFailed) return undefined
  return input.setupError?.trim() || "Worktree setup command failed."
}

export type WorkspaceTransitionOperation = "enter" | "leave" | "start"
export type WorkspaceTransitionPhase = "loading" | "success" | "error"
export type WorkspaceProgressStepState = "pending" | "active" | "complete"

export type WorkspaceProgressStep = {
  id: string
  label: string
  detail?: string
  state: WorkspaceProgressStepState
}

export type SessionWorkspaceTransitionRequest =
  | { operation: "enter"; sessionID: string; directory: string; name?: string }
  | { operation: "leave"; sessionID: string; directory: string }

export type SessionWorkspaceProgress = {
  operation: WorkspaceTransitionOperation
  phase: WorkspaceTransitionPhase
  title: string
  description: string
  steps: WorkspaceProgressStep[]
}

export type SessionWorkspaceProgressActions = {
  retry?: () => void
  dismiss?: () => void
}

export type NewSessionWorkspaceProgressStage = "workspace" | "session" | "prompt"

function withStepStates<T extends { id: string; label: string; detail?: string }>(steps: T[], active: T["id"]) {
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === active),
  )
  return steps.map((step, index) => ({
    ...step,
    state: index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending",
  })) satisfies WorkspaceProgressStep[]
}

export function createWorkspaceTransitionLoadingProgress(
  request: SessionWorkspaceTransitionRequest,
): SessionWorkspaceProgress {
  if (request.operation === "leave") {
    return {
      operation: "leave",
      phase: "loading",
      title: "Leaving worktree",
      description: "Returning this session to the main checkout.",
      steps: [
        {
          id: "leave",
          label: "Return to main checkout",
          detail: "Updating this session workspace.",
          state: "active",
        },
      ],
    }
  }

  return {
    operation: "enter",
    phase: "loading",
    title: "Moving session to worktree",
    description: "Creating an isolated checkout and binding this session to it.",
    steps: [
      {
        id: "enter",
        label: "Create and bind checkout",
        detail: "Preparing the worktree and updating this session workspace.",
        state: "active",
      },
    ],
  }
}

export function createWorkspaceTransitionSuccessProgress(input: {
  operation: "enter" | "leave"
  description?: string
}): SessionWorkspaceProgress {
  if (input.operation === "leave") {
    return {
      operation: "leave",
      phase: "success",
      title: "Main checkout active",
      description: input.description ?? "This session now runs from the main checkout. The worktree remains available.",
      steps: [
        {
          id: "leave",
          label: "Return to main checkout",
          detail: "Session workspace updated.",
          state: "complete",
        },
      ],
    }
  }

  return {
    operation: "enter",
    phase: "success",
    title: "Worktree active",
    description: input.description ?? "This session now runs in the isolated checkout.",
    steps: [
      {
        id: "enter",
        label: "Create and bind checkout",
        detail: "Session workspace updated.",
        state: "complete",
      },
    ],
  }
}

export function createWorkspaceTransitionErrorProgress(input: {
  operation: WorkspaceTransitionOperation
  message: string
}): SessionWorkspaceProgress {
  const title =
    input.operation === "leave"
      ? "Leave worktree failed"
      : input.operation === "enter"
        ? "Move to worktree failed"
        : "Worktree setup failed"

  return {
    operation: input.operation,
    phase: "error",
    title,
    description: input.message,
    steps: [],
  }
}

export function createNewSessionWorkspaceProgress(input: {
  selection: Exclude<NewSessionWorkspaceSelection, { mode: "current" }>
  stage: NewSessionWorkspaceProgressStage
}): SessionWorkspaceProgress {
  const workspaceStep =
    input.selection.mode === "create"
      ? { id: "workspace", label: "Create checkout", detail: "Preparing a new git worktree." }
      : { id: "workspace", label: "Bind worktree", detail: "Using the selected checkout." }

  return {
    operation: "start",
    phase: "loading",
    title: "Starting worktree session",
    description: "Preparing the workspace and sending your first prompt.",
    steps: withStepStates(
      [
        { id: "session", label: "Prepare session", detail: "Creating the conversation state." },
        workspaceStep,
        { id: "prompt", label: "Send prompt", detail: "Dispatching your first message." },
      ],
      input.stage,
    ),
  }
}

export function createNewSessionWorkspaceSuccessProgress(): SessionWorkspaceProgress {
  return {
    operation: "start",
    phase: "success",
    title: "Worktree session started",
    description: "The session is ready and your prompt was sent.",
    steps: [
      { id: "session", label: "Prepare session", detail: "Conversation state is ready.", state: "complete" },
      { id: "workspace", label: "Prepare workspace", detail: "Workspace setup complete.", state: "complete" },
      { id: "prompt", label: "Send prompt", detail: "First prompt dispatched.", state: "complete" },
    ],
  }
}
