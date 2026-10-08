import type { SessionPartPage, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

export type PartSummaryLoad = {
  sessionID: string
  messageID: string
  more?: boolean
  force?: boolean
  partID?: string
  older?: boolean
  version?: string
}
export type PartSummaryRange = { firstID: string; lastID: string; count: number; end: boolean }
export type PartSummaryPageState = Omit<SessionPartPage, "items"> & {
  ranges: PartSummaryRange[]
  stale: boolean
}
export type PartSummaryRefresh = {
  page: PartSummaryPageState
  versions: ReadonlyMap<string, string>
}
export type PartSummaryWindow = SessionPartPage & { ranges: PartSummaryRange[] }
type PageAction = "apply" | "preserve" | "retry"

export function partSummaryPageState(page: SessionPartPage): PartSummaryPageState {
  return {
    nextCursor: page.nextCursor,
    previousCursor: page.previousCursor,
    hasMore: page.hasMore,
    hasEarlier: page.hasEarlier,
    ranges: page.items.length
      ? [{ firstID: page.items[0].id, lastID: page.items.at(-1)!.id, count: page.items.length, end: !page.hasMore }]
      : [],
    stale: false,
  }
}

const contains = (range: PartSummaryRange, id: string) => id >= range.firstID && id <= range.lastID
const countRange = (range: PartSummaryRange, items: readonly SessionPartSummary[]): PartSummaryRange => ({
  ...range,
  count: items.filter((item) => contains(range, item.id)).length,
})

function addRanges(
  previous: readonly PartSummaryRange[],
  incoming: readonly PartSummaryRange[],
  items: readonly SessionPartSummary[],
) {
  let ranges = previous.map((range) => ({ ...range }))
  for (const next of incoming) {
    const covering = ranges.find((range) => range.firstID <= next.firstID && range.lastID >= next.lastID)
    if (covering) {
      if (covering.lastID === next.lastID) covering.end = next.end
      continue
    }
    ranges = ranges.flatMap((range) => {
      if (range.lastID < next.firstID) return [{ ...range, end: false }]
      if (range.firstID > next.lastID) return [range]
      return [
        ...(range.firstID < next.firstID ? [{ ...range, lastID: next.firstID, end: false }] : []),
        ...(range.lastID > next.lastID ? [{ ...range, firstID: next.lastID }] : []),
      ]
    })
    ranges.push({ ...next })
  }
  return ranges.map((range) => countRange(range, items)).sort((a, b) => a.firstID.localeCompare(b.firstID))
}

export class PartSummarySupersededError extends Error {
  constructor() {
    super("Conversation summary changed while loading")
    this.name = "PartSummarySupersededError"
  }
}

export async function readPartSummaryRanges(input: {
  page: PartSummaryPageState
  accepted: ReadonlyMap<string, string>
  signal: AbortSignal
  read: (query: { partID?: string; cursor?: string; older?: boolean; limit: number }) => Promise<SessionPartPage>
}): Promise<PartSummaryWindow> {
  input.signal.throwIfAborted()
  const items = new Map<string, SessionPartSummary>()
  let ranges = input.page.ranges.map((range) => ({ ...range }))
  let navigation = input.page
  if (!ranges.length) {
    const page = await input.read({ limit: 100 })
    input.signal.throwIfAborted()
    for (const part of page.items) items.set(part.id, part)
    navigation = partSummaryPageState(page)
    ranges = navigation.ranges
  }
  for (const range of input.page.ranges) {
    let cursor: string | undefined
    let firstID: string | undefined
    for (let reads = 0; ; reads++) {
      if (reads > range.count) throw new PartSummarySupersededError()
      input.signal.throwIfAborted()
      const page = await input.read({
        partID: cursor ? undefined : range.lastID,
        cursor,
        older: !!cursor,
        limit: Math.max(1, Math.min(100, range.count)),
      })
      input.signal.throwIfAborted()
      if (page.items.some((part) => part.id > range.lastID)) throw new PartSummarySupersededError()
      if (firstID && page.items[0] && page.items[0].id >= firstID) throw new PartSummarySupersededError()
      firstID = page.items[0]?.id
      for (const part of page.items) if (contains(range, part.id)) items.set(part.id, part)
      if (!page.items.length || page.items[0].id <= range.firstID || !page.hasEarlier) break
      if (!page.previousCursor || page.previousCursor === cursor) throw new PartSummarySupersededError()
      cursor = page.previousCursor
    }
  }
  const uncovered = new Set([...input.accepted.keys()].filter((id) => !ranges.some((range) => contains(range, id))))
  const admitted = (id: string) => input.accepted.has(id) || ranges.some((range) => contains(range, id))
  while (uncovered.size) {
    input.signal.throwIfAborted()
    const lastID = [...uncovered].sort().at(-1)!
    const page = await input.read({ partID: lastID, limit: 100 })
    input.signal.throwIfAborted()
    if (page.items.some((part) => part.id > lastID)) throw new PartSummarySupersededError()
    const firstID = page.items[0]?.id
    for (const id of uncovered) if (!firstID || id >= firstID) uncovered.delete(id)
    const accepted = page.items.filter((part) => admitted(part.id))
    for (const part of accepted) items.set(part.id, part)
    const added = page.items.every((part) => admitted(part.id))
      ? partSummaryPageState(page).ranges
      : accepted.map((part) => ({
          firstID: part.id,
          lastID: part.id,
          count: 1,
          end: !page.hasMore && part.id === page.items.at(-1)?.id,
        }))
    ranges = addRanges(ranges, added, [...items.values()])
  }
  let nextCursor = navigation.nextCursor
  let hasMore = navigation.hasMore
  for (const range of input.page.ranges.filter((range) => range.end)) {
    input.signal.throwIfAborted()
    const boundary = await input.read({ partID: range.lastID, limit: 1 })
    input.signal.throwIfAborted()
    if (boundary.items.some((part) => part.id > range.lastID)) throw new PartSummarySupersededError()
    if (boundary.items.length && !boundary.hasMore) continue
    const page = await input.read({ cursor: boundary.nextCursor ?? undefined, limit: 100 })
    input.signal.throwIfAborted()
    const tail = page.items.filter((part) => part.id > range.lastID)
    for (const part of tail) items.set(part.id, part)
    ranges = addRanges(ranges, partSummaryPageState({ ...page, items: tail }).ranges, [...items.values()])
    if (!input.page.hasMore) {
      hasMore = page.hasMore
      nextCursor = page.nextCursor
    }
  }
  return {
    items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
    nextCursor,
    previousCursor: navigation.previousCursor,
    hasMore,
    hasEarlier: navigation.hasEarlier,
    ranges,
  }
}

export function planPartSummaryPage(
  current: readonly SessionPartSummary[],
  previous: PartSummaryPageState | undefined,
  incoming: PartSummaryWindow,
  request: PartSummaryLoad,
  action: Exclude<PageAction, "retry">,
  refresh?: PartSummaryRefresh,
) {
  const targeted = request.force && !!request.partID
  const currentByID = new Map(current.map((part) => [part.id, part]))
  const items = new Map(
    (request.more || targeted || action === "preserve" || refresh ? current : []).map((part) => [part.id, part]),
  )
  if (refresh) {
    for (const part of current) {
      if (refresh.versions.get(part.id) === part.content.version) items.delete(part.id)
    }
  }
  for (const part of incoming.items) {
    if (refresh && action === "preserve") {
      const live = currentByID.get(part.id)
      const version = refresh.versions.get(part.id)
      if (live && live.content.version !== version) continue
      if (!live && version !== undefined) continue
    }
    items.set(part.id, action === "preserve" ? (items.get(part.id) ?? part) : part)
  }
  const nextItems = [...items.values()].sort((a, b) => a.id.localeCompare(b.id))
  const page =
    targeted && previous
      ? previous
      : {
          nextCursor: request.more && request.older && previous ? previous.nextCursor : incoming.nextCursor,
          hasMore: request.more && request.older ? (previous?.hasMore ?? incoming.hasMore) : incoming.hasMore,
          previousCursor: request.more && !request.older ? (previous?.previousCursor ?? null) : incoming.previousCursor,
          hasEarlier: request.more && !request.older ? (previous?.hasEarlier ?? false) : incoming.hasEarlier,
        }
  return {
    items: nextItems,
    removedIDs: current.filter((part) => !items.has(part.id)).map((part) => part.id),
    page: {
      nextCursor: page.nextCursor,
      previousCursor: page.previousCursor,
      hasMore: page.hasMore,
      hasEarlier: page.hasEarlier,
      ranges: addRanges(
        refresh ? [] : request.more || targeted || action === "preserve" ? (previous?.ranges ?? []) : [],
        incoming.ranges,
        nextItems,
      ),
      stale: !!previous?.stale && !refresh,
    },
  }
}

export function createPartSummaryLoader(input: {
  page: (messageID: string) => PartSummaryPageState | undefined
  summaries: (messageID: string) => readonly SessionPartSummary[]
  read: (
    request: PartSummaryLoad,
    cursor: string | undefined,
    signal: AbortSignal,
    refresh?: PartSummaryRefresh,
  ) => Promise<{ page: PartSummaryWindow; action: PageAction }>
  apply: (
    request: PartSummaryLoad,
    page: PartSummaryWindow,
    action: Exclude<PageAction, "retry">,
    refresh?: PartSummaryRefresh,
  ) => void
}) {
  const pending = new Map<string, Promise<void>>()
  const queued = new Map<string, Promise<void>>()
  const load = (request: PartSummaryLoad, signal: AbortSignal): Promise<void> => {
    const previous = pending.get(request.messageID)
    const target = () => input.summaries(request.messageID).find((part) => part.id === request.partID)
    if (!request.force && !request.more && (!request.partID || target())) {
      if (previous) return previous
      if (input.page(request.messageID)?.stale === false) return Promise.resolve()
    }
    const key = JSON.stringify([
      request.messageID,
      request.more,
      request.force,
      request.partID,
      request.older,
      request.version,
    ])
    const duplicate = queued.get(key)
    if (duplicate) return duplicate
    const promise = Promise.resolve()
      .then(async () => {
        await previous?.catch(() => {})
        queued.delete(key)
        if (signal.aborted) return
        const execute = async (query: PartSummaryLoad, cursor?: string, refresh?: PartSummaryPageState) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const snapshot = refresh
              ? {
                  page: refresh,
                  versions: new Map(input.summaries(request.messageID).map((part) => [part.id, part.content.version])),
                }
              : undefined
            const result = await input.read(query, cursor, signal, snapshot)
            if (signal.aborted) return
            if (result.action === "retry") continue
            input.apply(query, result.page, result.action, snapshot)
            return
          }
          throw new PartSummarySupersededError()
        }
        const accepted = input.page(request.messageID)
        if (accepted && (accepted.stale || (request.force && !request.more && !request.partID))) {
          await execute({ sessionID: request.sessionID, messageID: request.messageID, force: true }, undefined, {
            ...accepted,
            ranges: accepted.ranges.map((range) => ({ ...range })),
          })
          if (signal.aborted || (!request.more && !request.partID)) return
        }
        if (request.version && target()?.content.version !== request.version) return
        const state = input.page(request.messageID)
        const cursor = request.more
          ? ((request.older ? state?.previousCursor : state?.nextCursor) ?? undefined)
          : undefined
        if (request.more && !cursor) return
        await execute(request, cursor)
      })
      .finally(() => {
        if (queued.get(key) === promise) queued.delete(key)
        if (pending.get(request.messageID) === promise) pending.delete(request.messageID)
      })
    queued.set(key, promise)
    pending.set(request.messageID, promise)
    return promise
  }
  return { load }
}
