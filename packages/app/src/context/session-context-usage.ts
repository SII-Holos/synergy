export type SessionContextUsageMessage = {
  id: string
  role: string
  includeInContext?: boolean
  time: {
    created: number
  }
  contextUsage?: unknown
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
  }
}

export function isSessionContextUsageMessage<T extends SessionContextUsageMessage>(
  message: T,
): message is T & { role: "assistant" } {
  if (message.role !== "assistant" || message.includeInContext === false) return false
  if (message.contextUsage !== undefined) return true
  return (
    (message.tokens?.input ?? 0) !== 0 || (message.tokens?.output ?? 0) !== 0 || (message.tokens?.reasoning ?? 0) !== 0
  )
}

function compareSessionContextUsageMessages(a: SessionContextUsageMessage, b: SessionContextUsageMessage) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

export function findLatestSessionContextUsageMessage<T extends SessionContextUsageMessage>(messages: T[]): T | null {
  let latest: T | null = null
  for (const message of messages) {
    if (!isSessionContextUsageMessage(message)) continue
    if (!latest || compareSessionContextUsageMessages(latest, message) < 0) latest = message
  }
  return latest
}

export function reduceLatestSessionContextUsageMessage<T extends SessionContextUsageMessage>(
  current: T | null | undefined,
  message: T,
): T | null | undefined {
  if (!isSessionContextUsageMessage(message)) return current
  if (!current || compareSessionContextUsageMessages(current, message) <= 0) return message
  return current
}

export function invalidateLatestSessionContextUsageMessage<T extends SessionContextUsageMessage>(
  current: T | null | undefined,
  messageID: string,
): T | null | undefined {
  if (current?.id !== messageID) return current
  return undefined
}
