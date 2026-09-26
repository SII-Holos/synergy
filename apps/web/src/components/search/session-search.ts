import { batch, createSignal, onCleanup } from "solid-js"
import type { GlobalSessionSearchResponse } from "@ericsanchezok/synergy-sdk/client"

export type SearchPage = Pick<GlobalSessionSearchResponse, "data" | "total">
export type SearchSession = SearchPage["data"][number]
export type SearchQuery = { search: string; includeArchived: boolean }
export type SearchRequest = SearchQuery & { offset: number; limit: number; signal: AbortSignal }

export function createSessionSearch(fetchPage: (request: SearchRequest) => Promise<SearchPage>) {
  const [results, setResults] = createSignal<SearchSession[]>([])
  const [total, setTotal] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [moreError, setMoreError] = createSignal<string | null>(null)
  const [hasMore, setHasMore] = createSignal(false)
  let query: SearchQuery = { search: "", includeArchived: false }
  let offset = 0
  let generation = 0
  let controller: AbortController | undefined
  let disposed = false

  const invalidate = () => {
    generation++
    controller?.abort()
    batch(() => {
      setResults([])
      setTotal(0)
      setError(null)
      setMoreError(null)
      setHasMore(false)
      setLoading(true)
      setLoadingMore(false)
    })
    offset = 0
  }

  const request = async (append: boolean) => {
    if (disposed) return
    const version = ++generation
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    batch(() => {
      if (append) {
        setLoadingMore(true)
        setMoreError(null)
      } else {
        setLoading(true)
        setError(null)
      }
    })
    try {
      const page = await fetchPage({ ...query, offset, limit: 50, signal })
      if (disposed || version !== generation) return
      offset += page.data.length
      batch(() => {
        const seen = new Set(append ? results().map((item) => item.id) : [])
        const unique = page.data.filter((item) => {
          if (seen.has(item.id)) return false
          seen.add(item.id)
          return true
        })
        setResults((prev) => (append ? [...prev, ...unique] : unique))
        setTotal(page.total)
        setHasMore(page.data.length > 0 && offset < page.total)
      })
    } catch (cause) {
      if (disposed || version !== generation) return
      const message = cause instanceof Error ? cause.message : String(cause)
      if (append) setMoreError(message)
      else setError(message)
    } finally {
      if (!disposed && version === generation) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  onCleanup(() => {
    disposed = true
    generation++
    controller?.abort()
  })

  return {
    results,
    total,
    loading,
    loadingMore,
    error,
    moreError,
    hasMore,
    invalidate,
    start(next: SearchQuery) {
      invalidate()
      query = next
      return request(false)
    },
    retry: () => request(false),
    loadMore: () => {
      if (loading() || loadingMore() || !hasMore()) return Promise.resolve()
      return request(true)
    },
  }
}
