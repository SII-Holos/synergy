import type { I18n, MessageDescriptor } from "@lingui/core"
import type { SessionActivity } from "@ericsanchezok/synergy-sdk/client"
import { translateDescriptor } from "@/locales/translate"
import { S } from "./session-i18n"

export type SessionTransitionKind = "new-session" | "new-worktree-session" | "enter-worktree" | "leave-worktree"
export type SessionTransitionPhase = "loading" | "success" | "error"
export type SessionTransitionCopy = string | MessageDescriptor
export type SessionTransitionProgress = {
  kind: SessionTransitionKind
  phase: SessionTransitionPhase
  activity?: SessionActivity
  title?: SessionTransitionCopy
  description?: SessionTransitionCopy
  error?: { code?: string; message: string }
  retryLabel?: MessageDescriptor
  dismissLabel?: MessageDescriptor
}
export type SessionTransitionActions = { retry?: () => void; dismiss?: () => void }

export function translateSessionTransitionCopy(copy: SessionTransitionCopy | undefined, i18n: Pick<I18n, "_">): string {
  return copy === undefined ? "" : typeof copy === "string" ? copy : translateDescriptor(copy, i18n)
}

export function isSessionTransitionBlocking(progress: SessionTransitionProgress | null | undefined) {
  return progress?.phase === "loading" || progress?.phase === "error"
}

export function createSessionActivityProgress(
  kind: SessionTransitionKind,
  phase: SessionActivity["phase"],
): SessionTransitionProgress {
  return { kind, phase: "loading", activity: { phase, startedAt: Date.now() } }
}

export function createNewSessionTransitionProgress() {
  return createSessionActivityProgress("new-session", "submitting_input")
}
export function createSessionPreparationProgress() {
  return createSessionActivityProgress("new-session", "checking_submission")
}
export function createNewSessionTransitionSuccessProgress(): SessionTransitionProgress {
  return { kind: "new-session", phase: "success" }
}
export function createNewSessionTransitionAcceptedProgress() {
  return createSessionActivityProgress("new-session", "materializing_input")
}
export function createSessionTransitionHandoffErrorProgress(input: {
  kind: SessionTransitionKind
  message?: string
  error?: { code?: string; message: string }
}): SessionTransitionProgress {
  return {
    kind: input.kind,
    phase: "error",
    title: { id: "session.submission.startFailed", message: "Unable to start execution" },
    description: input.message ?? {
      id: "session.submission.savedFailure",
      message: "Your message is saved. Retry to resume processing.",
    },
    error: input.error,
    retryLabel: input.error?.code === "SessionPaused" ? S.transitionContinue : S.submissionRetry,
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
    dismissLabel: S.submissionRestoreDraft,
  }
}
