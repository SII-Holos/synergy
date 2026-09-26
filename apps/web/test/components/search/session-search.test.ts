import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionSearch, type SearchPage, type SearchRequest } from "../../../src/components/search/session-search"

function fixture() {
  const requests: { input: SearchRequest; resolve: (page: SearchPage) => void; reject: (error: Error) => void }[] = []
  let dispose!: () => void
  const search = createRoot((cleanup) => {
    dispose = cleanup
    return createSessionSearch((input) => new Promise((resolve, reject) => requests.push({ input, resolve, reject })))
  })
  return { search, requests, dispose }
}

const page = (ids: string[], total = ids.length): SearchPage => ({
  data: ids.map((id) => ({
    id,
    title: id,
    scope: { type: "home", id: "home", local: null },
    time: { created: 1, updated: 1 },
  })),
  total,
})

describe("session search ownership", () => {
  test("invalidates a reply as soon as input changes, including the debounce interval", async () => {
    const { search, requests, dispose } = fixture()
    const first = search.start({ search: "old", includeArchived: false })
    search.invalidate()
    expect(requests[0].input.signal.aborted).toBe(true)
    requests[0].resolve(page(["old"]))
    await first
    expect(search.results()).toEqual([])
    const second = search.start({ search: "new", includeArchived: true })
    requests[1].resolve(page(["new"]))
    await second
    expect(search.results().map((item) => item.id)).toEqual(["new"])
    expect(search.loading()).toBe(false)
    dispose()
  })

  test("failure is not empty success and retry retains the failed query", async () => {
    const { search, requests, dispose } = fixture()
    const first = search.start({ search: "query", includeArchived: true })
    requests[0].reject(new Error("offline"))
    await first
    expect(search.error()).toBe("offline")
    expect(search.loading()).toBe(false)
    const retry = search.retry()
    expect(requests[1].input).toMatchObject({ search: "query", includeArchived: true, offset: 0, limit: 50 })
    requests[1].resolve(page(["found"]))
    await retry
    expect(search.error()).toBeNull()
    expect(search.results()).toHaveLength(1)
    dispose()
  })

  test("failed pagination retains results and retries the same offset only once", async () => {
    const { search, requests, dispose } = fixture()
    const first = search.start({ search: "query", includeArchived: false })
    requests[0].resolve(page(["a", "b"], 4))
    await first
    const more = search.loadMore()
    await search.loadMore()
    expect(requests).toHaveLength(2)
    requests[1].reject(new Error("page offline"))
    await more
    expect(search.results().map((item) => item.id)).toEqual(["a", "b"])
    expect(search.moreError()).toBe("page offline")
    const retry = search.loadMore()
    expect(requests[2].input.offset).toBe(2)
    requests[2].resolve(page(["b", "c"], 4))
    await retry
    expect(search.results().map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(search.hasMore()).toBe(false)
    dispose()
  })

  test("query replacement rejects old pages and disposal aborts requests", async () => {
    const { search, requests, dispose } = fixture()
    const first = search.start({ search: "old", includeArchived: false })
    requests[0].resolve(page(["old"], 4))
    await first
    const more = search.loadMore()
    const next = search.start({ search: "new", includeArchived: false })
    expect(requests[1].input.signal.aborted).toBe(true)
    requests[2].resolve(page(["new"]))
    await next
    requests[1].resolve(page(["stale"], 4))
    await more
    expect(search.results().map((item) => item.id)).toEqual(["new"])
    const last = search.start({ search: "closed", includeArchived: false })
    dispose()
    expect(requests[3].input.signal.aborted).toBe(true)
    requests[3].resolve(page(["after close"]))
    await last
    expect(search.results()).toEqual([])
  })
})
