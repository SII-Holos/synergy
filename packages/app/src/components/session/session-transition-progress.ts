import type { I18n, MessageDescriptor } from "@lingui/core"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { translateDescriptor } from "@/locales/translate"
import { S } from "./session-i18n"

export type SessionTransitionKind = "new-session" | "new-worktree-session" | "enter-worktree" | "leave-worktree"

export type SessionTransitionPhase = "loading" | "success" | "error"
export type SessionTransitionStepState = "pending" | "active" | "complete"

export type SessionTransitionCopy = string | MessageDescriptor
export function translateSessionTransitionCopy(copy: SessionTransitionCopy, i18n: Pick<I18n, "_">): string {
  return typeof copy === "string" ? copy : translateDescriptor(copy, i18n)
}

export type SessionTransitionStep = {
  id: string
  label: MessageDescriptor
  detail?: MessageDescriptor
  state: SessionTransitionStepState
}

export type SessionTransitionProgress = {
  kind: SessionTransitionKind
  phase: SessionTransitionPhase
  title: SessionTransitionCopy
  description: SessionTransitionCopy
  steps: SessionTransitionStep[]
}

export type SessionTransitionActions = {
  retry?: () => void
  dismiss?: () => void
}

export type SessionStartupStage = "workspace" | "message" | "complete"

export type SessionStartupWorkspaceStep = {
  label: MessageDescriptor
  activeDetail: MessageDescriptor
  completeDetail: MessageDescriptor
}

type SessionStartupStepsInput =
  | { stage: "workspace"; workspace: SessionStartupWorkspaceStep }
  | { stage: "message" | "complete"; workspace?: SessionStartupWorkspaceStep }

const presentationByKind = {
  "new-session": { icon: "session.new", kicker: S.scopesNewSession },
  "new-worktree-session": { icon: "workspace.worktree", kicker: S.worktreeCardWorktreeSession },
  "enter-worktree": { icon: "workspace.enterWorktree", kicker: S.worktreeCardSessionWorktree },
  "leave-worktree": { icon: "workspace.leaveWorktree", kicker: S.worktreeCardMainCheckout },
} satisfies Record<SessionTransitionKind, { icon: SemanticIconTokenName; kicker: MessageDescriptor }>

export function sessionTransitionPresentation(progress: SessionTransitionProgress) {
  const presentation = presentationByKind[progress.kind]
  const icon =
    progress.phase === "success"
      ? getSemanticIcon("state.success")
      : progress.phase === "error"
        ? getSemanticIcon("state.error")
        : getSemanticIcon(presentation.icon)
  return { icon, kicker: presentation.kicker }
}

export function isSessionTransitionBlocking(progress: SessionTransitionProgress | null | undefined) {
  return progress?.phase === "loading" || progress?.phase === "error"
}

export function createSessionStartupSteps(input: SessionStartupStepsInput): SessionTransitionStep[] {
  const messageState = input.stage === "workspace" ? "pending" : input.stage === "message" ? "active" : "complete"
  const steps: SessionTransitionStep[] = [
    {
      id: "session",
      label: S.transitionStepPrepareSession,
      detail: S.worktreeDetailConversationReady,
      state: "complete",
    },
  ]

  if (input.workspace) {
    const workspaceComplete = input.stage !== "workspace"
    steps.push({
      id: "workspace",
      label: input.workspace.label,
      detail: workspaceComplete ? input.workspace.completeDetail : input.workspace.activeDetail,
      state: workspaceComplete ? "complete" : "active",
    })
  }

  steps.push({
    id: "message",
    label: S.transitionStepSubmitMessage,
    detail: messageState === "complete" ? S.transitionDetailMessageQueued : S.transitionDescSubmitting,
    state: messageState,
  })
  return steps
}

export function createNewSessionTransitionProgress(): SessionTransitionProgress {
  return {
    kind: "new-session",
    phase: "loading",
    title: S.transitionTitleStarting,
    description: S.transitionDescSubmitting,
    steps: createSessionStartupSteps({ stage: "message" }),
  }
}

export function createNewSessionTransitionSuccessProgress(): SessionTransitionProgress {
  return {
    kind: "new-session",
    phase: "success",
    title: S.transitionTitleAccepted,
    description: S.transitionDescQueued,
    steps: createSessionStartupSteps({ stage: "complete" }),
  }
}

export function createNewSessionTransitionErrorProgress(input: {
  title: string
  message: string
}): SessionTransitionProgress {
  return {
    kind: "new-session",
    phase: "error",
    title: input.title,
    description: input.message,
    steps: [],
  }
}
