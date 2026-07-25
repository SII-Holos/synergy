import type { SessionTransitionProgress } from "./session-transition-progress"
import type { NewSessionWorkspaceSelection } from "./worktree-session"

export const SESSION_TRANSITION_HANDOFF_TIMEOUT_MS = 30_000

type HandoffMessage = {
  id: string
  role?: string
  isRoot?: boolean
  visible?: boolean
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
      message.id === messageID && message.role === "user" && message.isRoot === true && message.visible !== false,
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
  messages: ReadonlyArray<Pick<HandoffMessage, "id">>
  inbox: ReadonlyArray<HandoffInboxItem> | undefined
}):
  | {
      itemID: string
      messageID: string
      acceptedAt?: number
      workspaceSelection?: NewSessionWorkspaceSelection
    }
  | undefined {
  if (input.messages.length > 0 || input.inbox === undefined) return
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
