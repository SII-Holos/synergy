import { createSignal, type Accessor } from "solid-js"
import type { Session, SessionChildrenPage } from "@ericsanchezok/synergy-sdk/client"
import { normalizeSubsessionSearch, type SubsessionCursor } from "./subsession"

export type SubsessionPageRequest = {
  sessionID: string
  limit: number
  search?: string
  cursor: SubsessionCursor | null
}

export type LoadSubsessionPageInput = {
  pageIndex: number
  cursor: SubsessionCursor | null
  startCursors?: (SubsessionCursor | null)[]
  query?: string
}

export function createSubsessionController(options: {
  sessionID: Accessor<string>
  loadChildren: (request: SubsessionPageRequest) => Promise<SessionChildrenPage>
  pageSize?: number
}) {
  const pageSize = options.pageSize ?? 8
  const [items, setItems] = createSignal<Session[]>([])
  const [total, setTotal] = createSignal<number>()
  const [nextCursor, setNextCursor] = createSignal<SubsessionCursor | null>(null)
  const [pageIndex, setPageIndex] = createSignal(0)
  const [startCursors, setStartCursors] = createSignal<(SubsessionCursor | null)[]>([null])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  let requestSeq = 0
  let latestRequest: LoadSubsessionPageInput | undefined
  let resultSessionID: string | undefined
  let resultQuery: string | undefined

  function clearResults() {
    setItems([])
    setTotal(undefined)
    setNextCursor(null)
    setPageIndex(0)
    setStartCursors([null])
  }

  function reset() {
    requestSeq += 1
    latestRequest = undefined
    resultSessionID = undefined
    resultQuery = undefined
    clearResults()
    setLoading(false)
    setError(false)
  }

  async function loadPage(input: LoadSubsessionPageInput) {
    const sessionID = options.sessionID()
    if (!sessionID) return
    const query = normalizeSubsessionSearch(input.query ?? "")
    const requested = {
      ...input,
      query: query || undefined,
      startCursors: input.startCursors ? [...input.startCursors] : undefined,
    }
    if (sessionID !== resultSessionID || query !== resultQuery) {
      resultSessionID = sessionID
      resultQuery = query
      clearResults()
    }
    latestRequest = requested

    const seq = ++requestSeq
    setLoading(true)
    setError(false)

    try {
      const page = await options.loadChildren({
        sessionID,
        limit: pageSize,
        search: requested.query,
        cursor: requested.cursor,
      })
      if (seq !== requestSeq || options.sessionID() !== sessionID) return

      setItems(page.items)
      setTotal(page.total)
      setNextCursor(page.nextCursor)
      setPageIndex(requested.pageIndex)
      if (requested.startCursors) setStartCursors(requested.startCursors)
      setLoading(false)
    } catch {
      if (seq !== requestSeq || options.sessionID() !== sessionID) return
      setLoading(false)
      setError(true)
    }
  }

  async function retry() {
    if (!latestRequest) return
    await loadPage(latestRequest)
  }

  return {
    items,
    total,
    nextCursor,
    pageIndex,
    startCursors,
    loading,
    error,
    reset,
    loadPage,
    retry,
  }
}
