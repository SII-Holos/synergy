export const DEFAULT_CAP = 500

export type MessageRef = {
  id: string
  time: {
    created: number
  }
}

export type MessageWindowState<T extends MessageRef = MessageRef> = {
  messages: T[]
  mode: "latest" | "history"
  pendingLatest: boolean
  pendingLatestIds: string[]
}

export type MessageWindowMetadata = {
  nextCursor: string | null
  hasMore: boolean
  total: number
  mode: MessageWindowState["mode"]
  pendingLatest: boolean
  pendingLatestIds: string[]
}

export type MessageWindowResult<T extends MessageRef> = {
  window: MessageWindowState<T>
  droppedIds: string[]
}

export function compareByTimeThenId(a: MessageRef, b: MessageRef) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

function mergeMessages<T extends MessageRef>(groups: T[][]) {
  const byID = new Map<string, T>()
  for (const group of groups) {
    for (const message of group) byID.set(message.id, message)
  }
  return Array.from(byID.values()).sort(compareByTimeThenId)
}

export function applyLatestPage<T extends MessageRef>(
  items: T[],
  referencedRoots: T[] = [],
  cap = DEFAULT_CAP,
): MessageWindowResult<T> {
  const messages = mergeMessages([referencedRoots, items])
  const dropCount = Math.max(0, messages.length - cap)
  const droppedIds = messages.slice(0, dropCount).map((message) => message.id)
  return {
    window: {
      messages: messages.slice(dropCount),
      mode: "latest",
      pendingLatest: false,
      pendingLatestIds: [],
    },
    droppedIds,
  }
}

export function prependOlderPage<T extends MessageRef>(
  current: MessageWindowState<T>,
  older: T[],
  cap = DEFAULT_CAP,
): MessageWindowResult<T> {
  const messages = mergeMessages([current.messages, older])
  const kept = messages.slice(0, cap)
  const keptIds = new Set(kept.map((message) => message.id))
  const pendingLatestIds = current.pendingLatestIds.filter((id) => !keptIds.has(id))
  return {
    window: {
      messages: kept,
      mode: "history",
      pendingLatest: pendingLatestIds.length > 0,
      pendingLatestIds,
    },
    droppedIds: messages.slice(kept.length).map((message) => message.id),
  }
}

export function reconcileMessage<T extends MessageRef>(
  current: MessageWindowState<T>,
  message: T,
  cap = DEFAULT_CAP,
): MessageWindowResult<T> {
  const existing = current.messages.some((item) => item.id === message.id)
  if (current.mode === "history" && !existing) {
    const pendingLatestIds = current.pendingLatestIds.includes(message.id)
      ? current.pendingLatestIds
      : [...current.pendingLatestIds, message.id]
    return {
      window: { ...current, pendingLatest: true, pendingLatestIds },
      droppedIds: [],
    }
  }

  const messages = mergeMessages([current.messages, [message]])
  if (current.mode === "history") {
    return {
      window: { ...current, messages },
      droppedIds: [],
    }
  }

  const dropCount = Math.max(0, messages.length - cap)
  return {
    window: {
      messages: messages.slice(dropCount),
      mode: "latest",
      pendingLatest: false,
      pendingLatestIds: [],
    },
    droppedIds: messages.slice(0, dropCount).map((item) => item.id),
  }
}

export function removeMessageFromWindow<T extends MessageRef>(
  current: MessageWindowState<T>,
  messageID: string,
): MessageWindowState<T> {
  const pendingLatestIds = current.pendingLatestIds.filter((id) => id !== messageID)
  return {
    ...current,
    messages: current.messages.filter((message) => message.id !== messageID),
    pendingLatest: pendingLatestIds.length > 0,
    pendingLatestIds,
  }
}
