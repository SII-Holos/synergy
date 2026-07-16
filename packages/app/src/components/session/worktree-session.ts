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
  return input.setupError?.trim() || S.worktreeSetupCommandFailed.message
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

function workspaceStepForSelection(selection: Exclude<NewSessionWorkspaceSelection, { mode: "current" }>) {
  return selection.mode === "create"
    ? {
        id: "workspace",
        label: S.worktreeStepCreateCheckout.message,
        detail: S.worktreeDetailPreparingWorktree.message,
      }
    : { id: "workspace", label: S.worktreeStepBindWorktree.message, detail: S.worktreeDetailUsingCheckout.message }
}

export function createWorkspaceTransitionLoadingProgress(
  request: SessionWorkspaceTransitionRequest,
): SessionWorkspaceProgress {
  if (request.operation === "leave") {
    return {
      operation: "leave",
      phase: "loading",
      title: S.worktreeTitleLeaving.message,
      description: S.worktreeDescLeaving.message,
      steps: [
        {
          id: "leave",
          label: S.worktreeStepReturnCheckout.message,
          detail: S.worktreeDetailUpdatingWorkspace.message,
          state: "active",
        },
      ],
    }
  }

  return {
    operation: "enter",
    phase: "loading",
    title: S.worktreeTitleMoving.message,
    description: S.worktreeDescMoving.message,
    steps: [
      {
        id: "enter",
        label: S.worktreeStepCreateBind.message,
        detail: S.worktreeDetailPreparingWorktreeBind.message,
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
      title: S.worktreeTitleMainActive.message,
      description: input.description ?? S.worktreeDescMainActive.message,
      steps: [
        {
          id: "leave",
          label: S.worktreeStepReturnCheckout.message,
          detail: S.worktreeDetailWorkspaceUpdated.message,
          state: "complete",
        },
      ],
    }
  }

  return {
    operation: "enter",
    phase: "success",
    title: S.worktreeTitleWorktreeActive.message,
    description: input.description ?? S.worktreeDescWorktreeActive.message,
    steps: [
      {
        id: "enter",
        label: S.worktreeStepCreateBind.message,
        detail: S.worktreeDetailWorkspaceUpdated.message,
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
      ? S.worktreeTitleLeaveFailed.message
      : input.operation === "enter"
        ? S.worktreeTitleMoveFailed.message
        : S.worktreeTitleSetupFailed.message

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
  return {
    operation: "start",
    phase: "loading",
    title: S.worktreeTitleStarting.message,
    description: S.worktreeDescStarting.message,
    steps: withStepStates(
      [
        {
          id: "session",
          label: S.worktreeStepPrepareSession.message,
          detail: S.worktreeDetailCreatingConversation.message,
        },
        workspaceStepForSelection(input.selection),
        { id: "prompt", label: S.worktreeStepSendPrompt.message, detail: S.worktreeDetailDispatchingPrompt.message },
      ],
      input.stage,
    ),
  }
}

export function createNewSessionWorkspaceSuccessProgress(input: {
  selection: Exclude<NewSessionWorkspaceSelection, { mode: "current" }>
}): SessionWorkspaceProgress {
  const workspaceStep = workspaceStepForSelection(input.selection)
  return {
    operation: "start",
    phase: "success",
    title: S.worktreeTitleStarted.message,
    description: S.worktreeDescStarted.message,
    steps: [
      {
        id: "session",
        label: S.worktreeStepPrepareSession.message,
        detail: S.worktreeDetailConversationReady.message,
        state: "complete",
      },
      { ...workspaceStep, detail: S.worktreeDetailWorkspaceSetupComplete.message, state: "complete" },
      {
        id: "prompt",
        label: S.worktreeStepSendPrompt.message,
        detail: S.worktreeDetailPromptDispatched.message,
        state: "complete",
      },
    ],
  }
}
