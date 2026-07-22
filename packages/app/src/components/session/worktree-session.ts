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
        label: S.worktreeStepCreateCheckout,
        activeDetail: S.worktreeDetailPreparingWorktree,
        completeDetail: S.worktreeDetailWorkspaceSetupComplete,
      }
    : {
        label: S.worktreeStepBindWorktree,
        activeDetail: S.worktreeDetailUsingCheckout,
        completeDetail: S.worktreeDetailWorkspaceSetupComplete,
      }
}

export function createWorkspaceTransitionLoadingProgress(
  request: SessionWorkspaceTransitionRequest,
): SessionTransitionProgress {
  if (request.operation === "leave") {
    return {
      kind: "leave-worktree",
      phase: "loading",
      title: S.worktreeTitleLeaving,
      description: S.worktreeDescLeaving,
      steps: [
        {
          id: "leave",
          label: S.worktreeStepReturnCheckout,
          detail: S.worktreeDetailUpdatingWorkspace,
          state: "active",
        },
      ],
    }
  }

  return {
    kind: "enter-worktree",
    phase: "loading",
    title: S.worktreeTitleMoving,
    description: S.worktreeDescMoving,
    steps: [
      {
        id: "enter",
        label: S.worktreeStepCreateBind,
        detail: S.worktreeDetailPreparingWorktreeBind,
        state: "active",
      },
    ],
  }
}
export function createWorkspaceTransitionRefreshProgress(input: {
  operation: "enter" | "leave"
}): SessionTransitionProgress {
  return {
    kind: input.operation === "leave" ? "leave-worktree" : "enter-worktree",
    phase: "loading",
    title: S.worktreeTitleRefreshing,
    description: S.worktreeDescRefreshing,
    steps: [
      {
        id: "refresh",
        label: S.worktreeStepRefreshStatus,
        detail: S.worktreeDetailRefreshingStatus,
        state: "active",
      },
    ],
  }
}

export function createWorkspaceTransitionSuccessProgress(input: {
  operation: "enter" | "leave"
  description?: SessionTransitionProgress["description"]
}): SessionTransitionProgress {
  if (input.operation === "leave") {
    return {
      kind: "leave-worktree",
      phase: "success",
      title: S.worktreeTitleMainActive,
      description: input.description ?? S.worktreeDescMainActive,
      steps: [
        {
          id: "leave",
          label: S.worktreeStepReturnCheckout,
          detail: S.worktreeDetailWorkspaceUpdated,
          state: "complete",
        },
      ],
    }
  }

  return {
    kind: "enter-worktree",
    phase: "success",
    title: S.worktreeTitleWorktreeActive,
    description: input.description ?? S.worktreeDescWorktreeActive,
    steps: [
      {
        id: "enter",
        label: S.worktreeStepCreateBind,
        detail: S.worktreeDetailWorkspaceUpdated,
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
    title: input.operation === "leave" ? S.worktreeTitleLeaveFailed : S.worktreeTitleMoveFailed,
    description: input.message,
    steps: [],
  }
}
export function createWorkspaceTransitionRefreshErrorProgress(input: {
  operation: "enter" | "leave"
  message: string
}): SessionTransitionProgress {
  return {
    kind: input.operation === "leave" ? "leave-worktree" : "enter-worktree",
    phase: "error",
    title: S.worktreeTitleRefreshFailed,
    description: { ...S.worktreeDescRefreshFailed, values: { message: input.message } },
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
    title: S.worktreeTitleStarting,
    description: S.worktreeDescStarting,
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
    title: S.worktreeTitleStarted,
    description: S.worktreeDescStarted,
    steps: createSessionStartupSteps({
      stage: "complete",
      workspace: workspaceStepForSelection(input.selection),
    }),
  }
}

export function createNewSessionWorkspaceErrorProgress(input: {
  title: SessionTransitionProgress["title"]
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
