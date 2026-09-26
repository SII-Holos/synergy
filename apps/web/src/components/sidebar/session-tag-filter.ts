import type { NavCursor, NavEntry, NavListState } from "@/context/layout"

export type TagFilterState = NavListState & { loading: boolean; error?: string }

export function createSessionTagFilter(options: {
  fetch(input: { tag: string; cursor?: NavCursor; signal: AbortSignal }): Promise<NavListState>
  publish(state: TagFilterState): void
}) {
  let tag: string | undefined
  let generation = 0
  let disposed = false
  const updates = new Map<string, NavEntry>()
  let abort: AbortController | undefined
  let state: TagFilterState = { items: [], total: 0, nextCursor: null, loading: false }
  const publish = (next: TagFilterState) => {
    state = next
    options.publish(state)
  }
  function apply(page: NavListState, entry: NavEntry): NavListState {
    const exists = page.items.some((row) => row.id === entry.id)
    const keep = !entry.archived && !entry.parentID && entry.tags?.includes(tag!)
    const items = page.items.filter((row) => row.id !== entry.id)
    if (keep) items.push(entry)
    items.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id))
    return { ...page, items, total: Math.max(0, page.total + (keep ? 1 : 0) - (exists ? 1 : 0)) }
  }
  async function load(cursor?: NavCursor) {
    if (!tag || disposed) return
    const current = ++generation
    abort?.abort()
    abort = new AbortController()
    updates.clear()
    publish({ ...state, loading: true, error: undefined })
    try {
      const page = await options.fetch({ tag, cursor, signal: abort.signal })
      if (disposed || current !== generation) return
      const items = cursor
        ? [...new Map([...state.items, ...page.items].map((row) => [row.id, row])).values()]
        : page.items
      let result: NavListState = { ...page, items }
      for (const entry of updates.values()) result = apply(result, entry)
      updates.clear()
      publish({ ...result, loading: false })
    } catch (error) {
      if (disposed || current !== generation) return
      updates.clear()
      publish({ ...state, loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    select(value: string | undefined) {
      if (disposed) return Promise.resolve()
      tag = value
      updates.clear()
      generation++
      abort?.abort()
      publish({ items: [], total: 0, nextCursor: null, loading: false })
      return load()
    },
    more() {
      if (!state.loading && state.nextCursor) return load(state.nextCursor)
    },
    refresh: () => load(),
    update(entry: NavEntry) {
      if (!tag || disposed) return
      if (state.loading) updates.set(entry.id, entry)
      publish({ ...state, ...apply(state, entry) })
    },
    dispose() {
      disposed = true
      generation++
      abort?.abort()
    },
  }
}
