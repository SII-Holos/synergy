type MessageWithID = { id: string }

function messageIndex(messages: readonly MessageWithID[], messageID: string) {
  return messages.findIndex((message) => message.id === messageID)
}

export function messagesBefore<T extends MessageWithID>(messages: readonly T[], messageID: string): T[] {
  const index = messageIndex(messages, messageID)
  return index < 0 ? [...messages] : messages.slice(0, index)
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
