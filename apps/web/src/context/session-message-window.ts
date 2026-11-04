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
  // True when older paging or a locate leaves this window short of the latest messages.
  // Cleared by latest replacement; other reconciliation and removals preserve the gap.
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

function newestMessage<T extends MessageRef>(messages: readonly T[]): T | undefined {
  let newest: T | undefined
  for (const message of messages) {
    if (!newest || compareByTimeThenId(newest, message) < 0) newest = message
  }
  return newest
}

function isNewerThanMessageWindow<T extends MessageRef>(message: T, messages: readonly T[]) {
  const newest = newestMessage(messages)
  return newest !== undefined && compareByTimeThenId(newest, message) < 0
}

export function retainPendingLatestIds<T extends MessageRef>(
  pendingIds: readonly string[],
  known: readonly T[],
  windowMessages: readonly T[],
  excluded?: ReadonlySet<string>,
) {
  const inWindow = new Set(windowMessages.map((message) => message.id))
  const knownById = new Map(known.map((message) => [message.id, message]))
  const newest = newestMessage(windowMessages)
  return pendingIds.filter((id) => {
    if (inWindow.has(id) || excluded?.has(id)) return false
    if (!newest) return true
    const message = knownById.get(id)
    if (!message) return true
    return compareByTimeThenId(newest, message) < 0
  })
}

export function insertInOrder<T extends MessageRef>(messages: T[], message: T): T[] {
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
  return messages.length <= cap ? messages : messages.slice(0, cap)
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
  // Kept and evicted ids are in the merged slice. A known id that is not
  // newer than the kept maximum is not a pending arrival either.
  const pendingLatestIds = retainPendingLatestIds(current.pendingLatestIds, messages, kept, evictedIds)
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
    const newer = isNewerThanMessageWindow(message, current.messages)
    const admitted = newer
      ? current.pendingLatestIds.includes(message.id)
        ? current.pendingLatestIds
        : [...current.pendingLatestIds, message.id]
      : newestMessage(current.messages)
        ? current.pendingLatestIds.filter((id) => id !== message.id)
        : current.pendingLatestIds
    const pendingLatestIds = retainPendingLatestIds(admitted, [message, ...current.messages], current.messages)
    return {
      window: { ...current, pendingLatest: pendingLatestIds.length > 0, pendingLatestIds },
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
    const pendingLatestIds = retainPendingLatestIds(
      current.pendingLatestIds.filter((id) => id !== message.id),
      messages,
      messages,
    )
    return {
      window: {
        ...current,
        messages,
        pendingLatest: pendingLatestIds.length > 0,
        pendingLatestIds,
      },
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
  const messages = current.messages.filter((message) => message.id !== messageID)
  const pendingLatestIds = retainPendingLatestIds(
    current.pendingLatestIds.filter((id) => id !== messageID),
    messages,
    messages,
  )
  return {
    ...current,
    messages,
    pendingLatest: pendingLatestIds.length > 0,
    pendingLatestIds,
  }
}
