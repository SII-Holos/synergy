import type { SessionStatus, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"
import { isWorkingStatus } from "@/utils/session-status"

import { createSessionActivityProgress, type SessionTransitionProgress } from "./session-transition-progress"
import { S } from "./session-i18n"

export type NewSessionWorkspaceSelection = SessionWorkspaceSelection
type WorktreeSelection = Extract<NewSessionWorkspaceSelection, { mode: "create" | "existing" }>

export type WorkspaceChangeStatus = SessionStatus

export function normalizePathForCompare(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.toLowerCase()
}

function isWorktreeDirectory(currentDirectory?: string, canonicalDirectory?: string) {
  if (!currentDirectory || !canonicalDirectory) return false
  return normalizePathForCompare(currentDirectory) !== normalizePathForCompare(canonicalDirectory)
}

export type NewSessionWorkspacePreference = "main" | "worktree"

export function defaultNewSessionWorkspaceSelection(input: {
  selected?: NewSessionWorkspaceSelection
  currentDirectory?: string
  canonicalDirectory?: string
  preference?: NewSessionWorkspacePreference
}): NewSessionWorkspaceSelection {
  if (input.selected) return input.selected
  if (input.preference === "worktree") return { mode: "create" }
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
  return isWorkingStatus(input.status)
}

export function worktreeSetupFailureMessage(input: { setupFailed?: boolean; setupError?: string } | undefined) {
  if (!input?.setupFailed) return undefined
  return input.setupError?.trim() || "Worktree setup command failed."
}

export type SessionWorkspaceTransitionRequest =
  | { operation: "enter"; sessionID: string; directory: string; name?: string }
  | { operation: "leave"; sessionID: string; directory: string }

export function createWorkspaceTransitionLoadingProgress(request: SessionWorkspaceTransitionRequest) {
  const progress = createSessionActivityProgress(
    request.operation === "leave" ? "leave-worktree" : "enter-worktree",
    "preparing_workspace",
  )
  progress.activity!.workspaceOperation = request.operation
  return progress
}
export function createWorkspaceTransitionRefreshProgress(input: { operation: "enter" | "leave" }) {
  return createSessionActivityProgress(
    input.operation === "leave" ? "leave-worktree" : "enter-worktree",
    "preparing_workspace",
  )
}
export function createWorkspaceTransitionSuccessProgress(input: {
  operation: "enter" | "leave"
  description?: SessionTransitionProgress["description"]
}): SessionTransitionProgress {
  return { kind: input.operation === "leave" ? "leave-worktree" : "enter-worktree", phase: "success" }
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
  }
}
export function createNewSessionWorkspaceProgress(input: {
  selection: WorktreeSelection
  stage: "workspace" | "message"
}) {
  const progress = createSessionActivityProgress(
    "new-worktree-session",
    input.stage === "workspace" ? "preparing_workspace" : "submitting_input",
  )
  if (input.stage === "workspace")
    progress.activity!.workspaceOperation = input.selection.mode === "create" ? "create" : "bind"
  return progress
}
export function createNewSessionWorkspaceSuccessProgress(_input: {
  selection: WorktreeSelection
}): SessionTransitionProgress {
  return { kind: "new-worktree-session", phase: "success" }
}
export function createNewSessionWorkspaceAcceptedProgress(_input: { selection: WorktreeSelection }) {
  return createSessionActivityProgress("new-worktree-session", "materializing_input")
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
    dismissLabel: S.submissionRestoreDraft,
  }
}
