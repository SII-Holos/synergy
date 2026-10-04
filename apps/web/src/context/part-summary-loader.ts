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
type PageState = Omit<SessionPartPage, "items">
type PageAction = "apply" | "preserve" | "retry"

export class PartSummarySupersededError extends Error {
  constructor() {
    super("Conversation summary changed while loading")
    this.name = "PartSummarySupersededError"
  }
}

export function planPartSummaryPage(
  current: readonly SessionPartSummary[],
  previous: PageState | undefined,
  incoming: SessionPartPage,
  request: PartSummaryLoad,
  action: Exclude<PageAction, "retry">,
) {
  const targeted = request.force && !!request.partID
  const items = new Map(
    (request.more || targeted || action === "preserve" ? current : []).map((part) => [part.id, part]),
  )
  for (const part of incoming.items) items.set(part.id, action === "preserve" ? (items.get(part.id) ?? part) : part)
  const page =
    targeted && previous
      ? previous
      : {
          nextCursor:
            request.more && request.older ? (previous?.nextCursor ?? incoming.nextCursor) : incoming.nextCursor,
          hasMore: request.more && request.older ? (previous?.hasMore ?? incoming.hasMore) : incoming.hasMore,
          previousCursor: request.more && !request.older ? (previous?.previousCursor ?? null) : incoming.previousCursor,
          hasEarlier: request.more && !request.older ? (previous?.hasEarlier ?? false) : incoming.hasEarlier,
        }
  return {
    items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
    page: {
      nextCursor: page.nextCursor,
      previousCursor: page.previousCursor,
      hasMore: page.hasMore,
      hasEarlier: page.hasEarlier,
    },
  }
}

export function createPartSummaryLoader(input: {
  page: (messageID: string) => PageState | undefined
  summaries: (messageID: string) => readonly SessionPartSummary[]
  read: (
    request: PartSummaryLoad,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ page: SessionPartPage; action: PageAction }>
  apply: (request: PartSummaryLoad, page: SessionPartPage, action: Exclude<PageAction, "retry">) => void
}) {
  const pending = new Map<string, Promise<void>>()
  const queued = new Map<string, Promise<void>>()
  const load = (request: PartSummaryLoad, signal: AbortSignal): Promise<void> => {
    const previous = pending.get(request.messageID)
    const target = () => input.summaries(request.messageID).find((part) => part.id === request.partID)
    if (!request.force && !request.more && (!request.partID || target())) {
      if (previous) return previous
      if (input.page(request.messageID)) return Promise.resolve()
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
        if (request.version && target()?.content.version !== request.version) return
        const state = input.page(request.messageID)
        const cursor = request.more
          ? ((request.older ? state?.previousCursor : state?.nextCursor) ?? undefined)
          : undefined
        if (request.more && !cursor) return
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await input.read(request, cursor, signal)
          if (signal.aborted) return
          if (result.action === "retry") continue
          input.apply(request, result.page, result.action)
          return
        }
        throw new PartSummarySupersededError()
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
