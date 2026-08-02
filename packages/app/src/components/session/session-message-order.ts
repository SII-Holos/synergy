type MessageWithID = { id: string }

function messageIndex(messages: readonly MessageWithID[], messageID: string) {
  return messages.findIndex((message) => message.id === messageID)
}

export function messagesBefore<T extends MessageWithID>(messages: readonly T[], messageID: string): T[] {
  const index = messageIndex(messages, messageID)
  return index < 0 ? [...messages] : messages.slice(0, index)
}

// A rollback summary arriving via message.updated can lag the message window:
// the new branch is already loaded while the summary still claims redo is
// possible. A strict prefix-cut would hide that branch until a forced refresh,
// so once any message after the cut survives the dropped set the cut degrades
// to filtering just the dropped ids.
export function messagesHiddenByRollback<T extends MessageWithID>(
  messages: readonly T[],
  rollback: { cutMessageID?: string; canUnrollback: boolean; droppedMessageIDs?: readonly string[] },
): T[] {
  const dropped = new Set(rollback.droppedMessageIDs ?? [])
  const filterDropped = () =>
    dropped.size === 0 ? [...messages] : messages.filter((message) => !dropped.has(message.id))
  if (!rollback.cutMessageID || !rollback.canUnrollback) return filterDropped()
  const cutIndex = messageIndex(messages, rollback.cutMessageID)
  if (cutIndex < 0) return [...messages]
  const newBranchLoaded = messages.slice(cutIndex).some((message) => !dropped.has(message.id))
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
