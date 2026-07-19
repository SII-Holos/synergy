export type SessionContextUsageMessage = {
  id: string
  role: string
  includeInContext?: boolean
  mode?: string
  time: {
    created: number
    completed?: number
  }
  contextUsage?: unknown
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
  }
}

export function isSessionContextUsageBarrier<T extends SessionContextUsageMessage>(
  message: T,
): message is T & { role: "assistant"; mode: "compaction" } {
  return (
    message.role === "assistant" &&
    message.mode === "compaction" &&
    message.includeInContext !== false &&
    message.time.completed !== undefined
  )
}

export function isSessionContextUsageMessage<T extends SessionContextUsageMessage>(
  message: T,
): message is T & { role: "assistant" } {
  if (message.role !== "assistant" || message.includeInContext === false) return false
  if (message.mode === "compaction") return isSessionContextUsageBarrier(message)
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

export function createSessionContextProjectionRevision() {
  const revisions = new Map<string, number>()
  let sequence = 0
  const key = (scopeKey: string, sessionID: string) => `${scopeKey}\0${sessionID}`
  const advance = (scopeKey: string, sessionID: string) => {
    const next = ++sequence
    revisions.set(key(scopeKey, sessionID), next)
    return next
  }

  return {
    begin: advance,
    invalidate: advance,
    isCurrent(scopeKey: string, sessionID: string, revision: number) {
      return revisions.get(key(scopeKey, sessionID)) === revision
    },
    release(scopeKey: string, sessionID: string) {
      revisions.delete(key(scopeKey, sessionID))
    },
  }
}
