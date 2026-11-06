import { createMemo, type Accessor } from "solid-js"
import {
  EMPTY_MESSAGES,
  EMPTY_PARTS,
  EMPTY_PART_TABLE,
  type SessionDataView,
} from "@ericsanchezok/synergy-ui/context/session-data-view"
import type { SessionTransitionEntry } from "./session-transition"
import { compareByTimeThenId } from "./session-message-window"
import { isOptimisticMessagePending } from "./session-optimistic-message"
import type { Message, SessionPartPage } from "@ericsanchezok/synergy-sdk/client"

const capturedPage = Object.freeze({ hasMore: false, hasEarlier: false, nextCursor: null, previousCursor: null })

export function submissionPartPage(input: {
  ready: boolean
  captured: boolean
  message?: Message
  page?: Omit<SessionPartPage, "items">
}) {
  if (input.ready && input.page) return input.page
  if (input.captured && (!input.ready || !input.message || isOptimisticMessagePending(input.message)))
    return capturedPage
}

export function createSessionSubmissionView(
  view: SessionDataView,
  draft: Accessor<SessionTransitionEntry["draft"]>,
  ready: Accessor<boolean> = () => true,
): SessionDataView {
  const messages = createMemo(() => {
    const message = draft()?.message
    if (!message) return undefined
    if (!ready()) return [message]
    const originalID = draft()?.originalMessageID
    const canonical = view
      .messagesFor(message.sessionID)
      .filter((item) => item.id !== originalID || !isOptimisticMessagePending(item))
    return canonical.some((item) => item.id === message.id)
      ? canonical
      : [...canonical, message].sort(compareByTimeThenId)
  })
  const parts = createMemo(() => {
    const captured = draft()
    const canonical = ready() && captured?.message ? view.partsFor(captured.message.id) : EMPTY_PARTS
    const missing = captured?.parts?.filter((part) => !canonical.some((item) => item.id === part.id)) ?? EMPTY_PARTS
    return missing.length ? [...canonical, ...missing].sort((a, b) => a.id.localeCompare(b.id)) : canonical
  })
  return {
    ...view,
    partTable: () => {
      const captured = draft()?.message
      const table = ready() ? view.partTable() : EMPTY_PART_TABLE
      return captured ? { ...table, [captured.id]: parts() } : table
    },
    messagesFor: (sessionID) =>
      draft()?.message?.sessionID === sessionID ? messages()! : ready() ? view.messagesFor(sessionID) : EMPTY_MESSAGES,
    partsFor: (messageID) => {
      const captured = draft()
      if (captured?.message?.id === messageID || captured?.originalMessageID === messageID) return parts()
      return ready() ? view.partsFor(messageID) : EMPTY_PARTS
    },
    sessionFor: (sessionID) => (ready() ? view.sessionFor(sessionID) : undefined),
  }
}
