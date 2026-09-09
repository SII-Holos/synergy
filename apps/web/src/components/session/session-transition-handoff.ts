import { isOptimisticMessagePending } from "@/context/session-optimistic-message"

import type { SessionTransitionProgress } from "./session-transition-progress"
import type { NewSessionWorkspaceSelection } from "./worktree-session"

export const SESSION_TRANSITION_HANDOFF_TIMEOUT_MS = 30_000

type HandoffMessage = {
  id: string
  role?: string
  isRoot?: boolean
  visible?: boolean
  metadata?: unknown
}

type HandoffInboxItem = {
  id?: string
  mode?: string
  messageID: string
  message?: {
    role?: string
    origin?: { type?: string }
    visible?: boolean
    metadata?: {
      sessionTransition?: {
        workspaceSelection?: NewSessionWorkspaceSelection
      }
    }
  }
  source?: { type?: string }
  time?: { created?: number }
}

export type SessionTransitionHandoff = {
  messageID: string
  itemID?: string
  acceptedAt?: number
  accepted?: SessionTransitionProgress
  workspaceSelection?: NewSessionWorkspaceSelection
  refreshAttempted?: boolean
  success: SessionTransitionProgress
}

export function isSessionTransitionHandoffReady(
  messageID: string | undefined,
  messages: ReadonlyArray<HandoffMessage>,
): boolean {
  if (!messageID) return false
  return messages.some(
    (message) =>
      message.id === messageID &&
      message.role === "user" &&
      message.isRoot === true &&
      message.visible !== false &&
      !isOptimisticMessagePending(message),
  )
}

export function decideSessionTransitionHandoff(input: {
  messageID: string
  messages: ReadonlyArray<HandoffMessage>
  inbox: ReadonlyArray<Pick<HandoffInboxItem, "messageID">> | undefined
  elapsedMs: number
  refreshAttempted: boolean
}): "waiting" | "refresh" | "stalled" | "ready" {
  if (isSessionTransitionHandoffReady(input.messageID, input.messages)) return "ready"
  if (input.elapsedMs >= SESSION_TRANSITION_HANDOFF_TIMEOUT_MS) return "stalled"
  if (
    input.inbox !== undefined &&
    !input.refreshAttempted &&
    !input.inbox.some((item) => item.messageID === input.messageID)
  ) {
    return "refresh"
  }
  return "waiting"
}

export function recoverSessionTransitionHandoff(input: {
  messages: ReadonlyArray<Pick<HandoffMessage, "id">> | undefined
  inbox: ReadonlyArray<HandoffInboxItem> | undefined
}):
  | {
      itemID: string
      messageID: string
      acceptedAt?: number
      workspaceSelection?: NewSessionWorkspaceSelection
    }
  | undefined {
  if (input.messages === undefined || input.messages.length > 0 || input.inbox === undefined) return
  const candidates = input.inbox.filter(
    (item) =>
      item.id &&
      item.mode === "task" &&
      item.message?.role === "user" &&
      item.message.visible !== false &&
      (item.message.origin?.type ?? item.source?.type) === "user",
  )
  if (candidates.length !== 1) return
  const [item] = candidates
  return {
    itemID: item.id!,
    messageID: item.messageID,
    ...(item.time?.created === undefined ? {} : { acceptedAt: item.time.created }),
    ...(item.message?.metadata?.sessionTransition?.workspaceSelection === undefined
      ? {}
      : { workspaceSelection: item.message.metadata.sessionTransition.workspaceSelection }),
  }
}

/**
 * Schedules a one-shot stall check for a handoff attempt, anchored to the
 * attempt identity (messageID + acceptedAt). A retry rewrites acceptedAt and
 * therefore re-schedules a fresh window; the check is skipped when the
 * attempt is no longer the live loading entry. Returns a cancel function.
 */
export function scheduleSessionTransitionHandoffDeadline(
  attempt: { messageID: string; acceptedAt: number },
  isCurrentAttempt: (attempt: { messageID: string; acceptedAt: number }) => boolean,
  onDeadline: () => void,
  options: {
    schedule?: (fn: () => void, delay: number) => unknown
    cancel?: (handle: unknown) => void
    now?: () => number
  } = {},
): () => void {
  const schedule = options.schedule ?? ((fn: () => void, delay: number) => setTimeout(fn, delay))
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const now = options.now ?? Date.now
  // A missing acceptedAt means the attempt was not anchored; count the window
  // from the scheduling moment.
  const acceptedAt = attempt.acceptedAt ?? now()
  const delay = Math.max(0, acceptedAt + SESSION_TRANSITION_HANDOFF_TIMEOUT_MS - now())
  let active = true
  const handle = schedule(() => {
    if (!active) return
    if (isCurrentAttempt(attempt)) onDeadline()
  }, delay)
  return () => {
    if (!active) return
    active = false
    cancel(handle)
  }
}
