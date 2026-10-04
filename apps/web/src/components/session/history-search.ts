export type HistorySearchInput = { query: string; reasoning?: boolean; tools?: boolean }
export type HistorySearchMatch = { messageID: string; partID: string; text: string }
type Page<T> = { items: T[]; nextCursor: string | null; preparing: boolean; prepared: number }

export function createHistorySearch<T extends HistorySearchMatch>(
  fetch: (input: HistorySearchInput & { cursor?: string; signal: AbortSignal }) => Promise<Page<T>>,
  changed: () => void,
) {
  const state: { items: T[]; loading: boolean; preparing: boolean; prepared: number; cursor?: string; error?: string } =
    { items: [], loading: false, preparing: false, prepared: 0 }
  let input: HistorySearchInput | undefined
  let controller: AbortController | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const load = async (more = false) => {
    if (!input || disposed || state.loading || (more && !state.cursor)) return
    clearTimeout(timer)
    const current = generation
    const abort = controller!
    state.loading = true
    state.error = undefined
    changed()
    try {
      let cursor = more ? state.cursor : undefined
      const items = new Map((more ? state.items : []).map((item) => [`${item.messageID}\0${item.partID}`, item]))
      for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
        const page = await fetch({ ...input, cursor, signal: abort.signal })
        if (disposed || current !== generation || abort.signal.aborted) return
        for (const item of page.items) items.set(`${item.messageID}\0${item.partID}`, item)
        state.items = [...items.values()]
        state.preparing = page.preparing
        state.prepared = page.prepared
        state.cursor = page.nextCursor ?? undefined
        changed()
        if (items.size || !page.nextCursor) break
        cursor = page.nextCursor
      }
      if (state.preparing) timer = setTimeout(() => void load(), 100)
      else if (!state.items.length && state.cursor) timer = setTimeout(() => void load(true), 0)
    } catch (error) {
      if (!disposed && current === generation && !abort.signal.aborted)
        state.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (!disposed && current === generation) {
        state.loading = false
        changed()
      }
    }
  }
  return {
    state,
    start(value: HistorySearchInput) {
      generation++
      controller?.abort()
      controller = new AbortController()
      clearTimeout(timer)
      input = value.query.trim() ? value : undefined
      Object.assign(state, {
        items: [],
        loading: false,
        preparing: false,
        prepared: 0,
        cursor: undefined,
        error: undefined,
      })
      changed()
      return load()
    },
    more: () => load(true),
    refresh: () => load(),
    dispose() {
      disposed = true
      generation++
      clearTimeout(timer)
      controller?.abort()
    },
  }
}
