export const DEFAULT_CAP = 500

export type MessageRef = {
  id: string
  time: {
    created: number
  }
  rootID?: string
}

export type MessageWindowState<T extends MessageRef = MessageRef> = {
  messages: T[]
  mode: "latest" | "history"
  pendingLatest: boolean
  pendingLatestIds: string[]
  // True when the bounded window's tail no longer reaches the true latest
  // messages (newest overflow was evicted by a history prepend). Cleared by
  // any latest page apply/reconcile; preserved by history prepends,
  // reconciles, and removals.
  tailMissingLatest: boolean
}

export type MessageWindowMetadata = {
  nextCursor: string | null
  hasMore: boolean
  total: number
  mode: MessageWindowState["mode"]
  pendingLatest: boolean
  pendingLatestIds: string[]
  tailMissingLatest: boolean
}

export type MessageWindowResult<T extends MessageRef> = {
  window: MessageWindowState<T>
  droppedIds: string[]
}

export function hasMessageWindowSnapshot<T>(
  messages: T[] | undefined,
  metadata: MessageWindowMetadata | undefined,
): messages is T[] {
  return messages !== undefined && metadata !== undefined
}

export function compareByTimeThenId(a: MessageRef, b: MessageRef) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

function insertInOrder<T extends MessageRef>(messages: T[], message: T): T[] {
  const last = messages.at(-1)
  if (last && compareByTimeThenId(last, message) <= 0) {
    // Common path: an incoming message is the newest — append at the tail.
    const next = messages.slice()
    next.push(message)
    return next
  }
  let lo = 0
  let hi = messages.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compareByTimeThenId(messages[mid], message) <= 0) lo = mid + 1
    else hi = mid
  }
  const next = messages.slice()
  next.splice(lo, 0, message)
  return next
}

function mergeMessages<T extends MessageRef>(groups: T[][]) {
  const byID = new Map<string, T>()
  for (const group of groups) {
    for (const message of group) byID.set(message.id, message)
  }
  return Array.from(byID.values()).sort(compareByTimeThenId)
}

function capLatestMessages<T extends MessageRef>(messages: T[], cap: number, referencedRoots: T[] = []) {
  const primary = messages.slice(Math.max(0, messages.length - cap))
  const primaryIDs = new Set(primary.map((message) => message.id))
  const referencedRootIDs = new Set(referencedRoots.map((message) => message.id))
  for (const message of primary) {
    if (message.rootID && !primaryIDs.has(message.rootID)) referencedRootIDs.add(message.rootID)
  }
  if (referencedRootIDs.size === 0) return primary
  const candidates = mergeMessages([referencedRoots, messages])
  return mergeMessages([candidates.filter((message) => referencedRootIDs.has(message.id)), primary])
}

export function applyLatestPage<T extends MessageRef>(
  items: T[],
  referencedRoots: T[] = [],
  cap = DEFAULT_CAP,
): MessageWindowResult<T> {
  const primary = mergeMessages([items])
  const messages = mergeMessages([referencedRoots, primary])
  const kept = capLatestMessages(primary, cap, referencedRoots)
  const keptIDs = new Set(kept.map((message) => message.id))
  const droppedIds = messages.filter((message) => !keptIDs.has(message.id)).map((message) => message.id)
  return {
    window: {
      messages: kept,
      mode: "latest",
      pendingLatest: false,
      pendingLatestIds: [],
      tailMissingLatest: false,
    },
    droppedIds,
  }
}

function capHistoryMessages<T extends MessageRef>(messages: T[], cap: number): T[] {
  if (messages.length <= cap) return messages
  const kept = messages.slice(0, cap)
  const overflowRootIDs = new Set(messages.slice(cap).flatMap((message) => (message.rootID ? [message.rootID] : [])))
  if (overflowRootIDs.size === 0) return kept
  return kept.filter((message) => !message.rootID || !overflowRootIDs.has(message.rootID))
}

export function prependOlderPage<T extends MessageRef>(
  current: MessageWindowState<T>,
  older: T[],
  cap = DEFAULT_CAP,
): MessageWindowResult<T> {
  const messages = mergeMessages([current.messages, older])
  const kept = capHistoryMessages(messages, cap)
  const keptIds = new Set(kept.map((message) => message.id))
  const droppedIds = messages.filter((message) => !keptIds.has(message.id)).map((message) => message.id)
  const evictedIds = new Set(droppedIds)
  // Pending arrivals are the newest messages; when the cap evicts them they no
  // longer belong to the pending set — the tail gap is tracked by
  // tailMissingLatest instead.
  const pendingLatestIds = current.pendingLatestIds.filter((id) => !keptIds.has(id) && !evictedIds.has(id))
  return {
    window: {
      messages: kept,
      mode: "history",
      pendingLatest: pendingLatestIds.length > 0,
      pendingLatestIds,
      tailMissingLatest: current.tailMissingLatest || droppedIds.length > 0,
    },
    droppedIds,
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

  // Incremental insert: the window stays sorted by compareByTimeThenId, so a
  // single message only needs its sorted insertion point instead of a full
  // merge + sort of the whole window. An existing message is replaced by
  // removing it first, then re-inserting at its new canonical position.
  const messages = existing
    ? insertInOrder(
        current.messages.filter((item) => item.id !== message.id),
        message,
      )
    : insertInOrder(current.messages, message)

  if (current.mode === "history") {
    return {
      window: { ...current, messages },
      droppedIds: [],
    }
  }

  const kept = capLatestMessages(messages, cap)
  const keptIDs = new Set(kept.map((item) => item.id))
  return {
    window: {
      messages: kept,
      mode: "latest",
      pendingLatest: false,
      pendingLatestIds: [],
      tailMissingLatest: false,
    },
    droppedIds: messages.filter((item) => !keptIDs.has(item.id)).map((item) => item.id),
  }
}

export function reconcileLoadedMessage<T extends MessageRef>(
  messages: T[] | undefined,
  metadata: MessageWindowMetadata | undefined,
  message: T,
  cap = DEFAULT_CAP,
): MessageWindowResult<T> | undefined {
  if (messages === undefined || metadata === undefined) return
  return reconcileMessage(
    {
      messages,
      mode: metadata.mode,
      pendingLatest: metadata.pendingLatest,
      pendingLatestIds: metadata.pendingLatestIds,
      tailMissingLatest: metadata.tailMissingLatest,
    },
    message,
    cap,
  )
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
