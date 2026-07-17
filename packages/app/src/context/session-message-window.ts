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
}

export type MessageWindowMetadata = {
  nextCursor: string | null
  hasMore: boolean
  total: number
  mode: MessageWindowState["mode"]
  pendingLatest: boolean
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
  return {
    window: {
      messages: kept,
      mode: "history",
      pendingLatest: current.pendingLatest,
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
    return {
      window: { ...current, pendingLatest: true },
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
    },
    droppedIds: messages.slice(0, dropCount).map((item) => item.id),
  }
}
