import type { Message, Part } from "@ericsanchezok/synergy-sdk/client"
import { compareByTimeThenId, type MessageWindowState } from "./session-message-window"

const OPTIMISTIC_METADATA_KEY = "synergyClientOptimistic"

type MessageWithMetadata = {
  metadata?: unknown
}

type OptimisticMetadata = {
  pending?: true
}

export function withOptimisticMessagePending(metadata: Record<string, unknown> | undefined) {
  return {
    ...metadata,
    [OPTIMISTIC_METADATA_KEY]: { pending: true },
  }
}

export function isOptimisticMessagePending(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false
  const metadata = (message as MessageWithMetadata).metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false
  const optimistic = (metadata as Record<string, unknown>)[OPTIMISTIC_METADATA_KEY]
  if (!optimistic || typeof optimistic !== "object" || Array.isArray(optimistic)) return false
  return (optimistic as OptimisticMetadata).pending === true
}

export function messageAllowsCanonicalActions(message: unknown): boolean {
  return !isOptimisticMessagePending(message)
}

export function handoffOptimisticMessage(input: {
  current: MessageWindowState<Message>
  optimisticParts?: Part[]
  canonicalParts?: Part[]
  optimisticID: string
  canonicalID: string
  total: number
}): {
  window: MessageWindowState<Message>
  canonicalParts?: Part[]
  total: number
} {
  if (input.optimisticID === input.canonicalID) {
    return {
      window: input.current,
      canonicalParts: input.canonicalParts ?? input.optimisticParts,
      total: input.total,
    }
  }

  const optimistic = input.current.messages.find((message) => message.id === input.optimisticID)
  const canonical = input.current.messages.find((message) => message.id === input.canonicalID)
  const messages = input.current.messages.filter((message) => message.id !== input.optimisticID)

  if (!canonical && optimistic) {
    messages.push({
      ...optimistic,
      id: input.canonicalID,
      rootID: optimistic.rootID === input.optimisticID ? input.canonicalID : optimistic.rootID,
    })
  }
  messages.sort(compareByTimeThenId)

  const pendingLatestIds = input.current.pendingLatestIds.filter((id) => id !== input.optimisticID)
  const optimisticWasPending = input.current.pendingLatestIds.includes(input.optimisticID)
  const canonicalVisible = messages.some((message) => message.id === input.canonicalID)
  if (canonicalVisible) {
    const index = pendingLatestIds.indexOf(input.canonicalID)
    if (index !== -1) pendingLatestIds.splice(index, 1)
  } else if (optimisticWasPending && !pendingLatestIds.includes(input.canonicalID)) {
    pendingLatestIds.push(input.canonicalID)
  }

  return {
    window: {
      ...input.current,
      messages,
      pendingLatest: pendingLatestIds.length > 0,
      pendingLatestIds,
    },
    canonicalParts:
      input.canonicalParts ??
      input.optimisticParts?.map((part) => ({
        ...part,
        messageID: input.canonicalID,
      })),
    total: Math.max(0, input.total - (optimistic && canonical ? 1 : 0)),
  }
}
