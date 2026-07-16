import {
  createSessionStartupSteps,
  type SessionStartupWorkspaceStep,
  type SessionTransitionProgress,
} from "./session-transition-progress"
import { S } from "./session-i18n"

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

export type SessionWorkspaceTransitionRequest =
  | { operation: "enter"; sessionID: string; directory: string; name?: string }
  | { operation: "leave"; sessionID: string; directory: string }

type NewSessionWorkspaceProgressStage = "workspace" | "message"

function workspaceStepForSelection(
  selection: Exclude<NewSessionWorkspaceSelection, { mode: "current" }>,
): SessionStartupWorkspaceStep {
  return selection.mode === "create"
    ? {
        label: "Create checkout",
        activeDetail: "Preparing a new git worktree.",
        completeDetail: "Workspace setup complete.",
      }
    : {
        label: "Bind worktree",
        activeDetail: "Using the selected checkout.",
        completeDetail: "Workspace setup complete.",
      }
}

export function createWorkspaceTransitionLoadingProgress(
  request: SessionWorkspaceTransitionRequest,
): SessionTransitionProgress {
  if (request.operation === "leave") {
    return {
      kind: "leave-worktree",
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
    kind: "enter-worktree",
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
}): SessionTransitionProgress {
  if (input.operation === "leave") {
    return {
      kind: "leave-worktree",
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
    kind: "enter-worktree",
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
  operation: "enter" | "leave"
  message: string
}): SessionTransitionProgress {
  return {
    kind: input.operation === "leave" ? "leave-worktree" : "enter-worktree",
    phase: "error",
    title: input.operation === "leave" ? "Leave worktree failed" : "Move to worktree failed",
    description: input.message,
    steps: [],
  }
}

export function createNewSessionWorkspaceProgress(input: {
  selection: Exclude<NewSessionWorkspaceSelection, { mode: "current" }>
  stage: NewSessionWorkspaceProgressStage
}): SessionTransitionProgress {
  return {
    kind: "new-worktree-session",
    phase: "loading",
    title: "Starting worktree session",
    description: "Preparing the workspace and submitting your first message.",
    steps: createSessionStartupSteps({
      stage: input.stage,
      workspace: workspaceStepForSelection(input.selection),
    }),
  }
}

export function createNewSessionWorkspaceSuccessProgress(input: {
  selection: Exclude<NewSessionWorkspaceSelection, { mode: "current" }>
}): SessionTransitionProgress {
  return {
    kind: "new-worktree-session",
    phase: "success",
    title: "Worktree session request accepted",
    description: "The workspace is ready and your first message is queued for processing.",
    steps: createSessionStartupSteps({
      stage: "complete",
      workspace: workspaceStepForSelection(input.selection),
    }),
  }
}

export function createNewSessionWorkspaceErrorProgress(input: {
  title: string
  message: string
}): SessionTransitionProgress {
  return {
    kind: "new-worktree-session",
    phase: "error",
    title: input.title,
    description: input.message,
    steps: [],
  }
}
