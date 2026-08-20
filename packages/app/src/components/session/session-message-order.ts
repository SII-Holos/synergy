type MessageWithID = { id: string }

type RollbackMessage = {
  id: string
  role: "user" | "assistant"
  isRoot?: boolean
  time: { created: number }
}

function messageIndex(messages: readonly MessageWithID[], messageID: string) {
  return messages.findIndex((message) => message.id === messageID)
}

export function messagesBefore<T extends MessageWithID>(messages: readonly T[], messageID: string): T[] {
  const index = messageIndex(messages, messageID)
  return index < 0 ? [...messages] : messages.slice(0, index)
}

// message.updated for a resent root can reach the window before session.updated
// invalidates redo. Keep that root visible without revealing non-root injections,
// which canonical rollback history continues to prefix-hide while redo is valid.
export function messagesHiddenByRollback<T extends RollbackMessage>(
  messages: readonly T[],
  rollback: {
    created: number
    cutMessageID?: string
    canUnrollback: boolean
    droppedMessageIDs?: readonly string[]
  },
): T[] {
  const dropped = new Set(rollback.droppedMessageIDs ?? [])
  const filterDropped = () =>
    dropped.size === 0 ? [...messages] : messages.filter((message) => !dropped.has(message.id))
  if (!rollback.cutMessageID || !rollback.canUnrollback) return filterDropped()
  const cutIndex = messageIndex(messages, rollback.cutMessageID)
  if (cutIndex < 0) return [...messages]
  const newBranchLoaded = messages.slice(cutIndex).some((message) => {
    if (dropped.has(message.id) || message.role !== "user") return false
    if (message.isRoot === false) return false
    return message.time.created > rollback.created
  })
  if (newBranchLoaded) return filterDropped()
  return messages.slice(0, cutIndex)
}

export function messagesFrom<T extends MessageWithID>(messages: readonly T[], messageID: string): T[] {
  const index = messageIndex(messages, messageID)
  return index < 0 ? [...messages] : messages.slice(index)
}

export function previousMessage<T extends MessageWithID>(messages: readonly T[], messageID: string): T | undefined {
  const index = messageIndex(messages, messageID)
  return index > 0 ? messages[index - 1] : undefined
}

export function selectMessagesInCanonicalOrder<T extends MessageWithID>(
  canonical: readonly T[],
  selected: readonly T[],
): T[] {
  const selectedIDs = new Set(selected.map((message) => message.id))
  return canonical.filter((message) => selectedIDs.has(message.id))
}

/**
 * Action-command assistants render as standalone rows only when the user
 * explicitly hid them from context: prefer the canonical includeInContext;
 * fall back to command.promptVisible for messages written before it was set.
 */
export function isActionCommandMessage(message: {
  metadata?: { command?: { kind?: string; promptVisible?: boolean }; promptVisible?: boolean } | unknown
  includeInContext?: boolean
}): boolean {
  const metadata = message.metadata as
    | { command?: { kind?: string; promptVisible?: boolean }; promptVisible?: boolean }
    | undefined
  if (metadata?.command?.kind !== "action") return false
  if (message.includeInContext !== undefined) return message.includeInContext === false
  return metadata.promptVisible === false
}
