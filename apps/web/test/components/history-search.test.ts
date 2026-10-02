import { expect, test } from "bun:test"
import { createHistorySearch } from "../../src/components/session/history-search"

test("history search aborts obsolete queries, follows empty bounded pages, and keeps stable identities", async () => {
  const requests: {
    query: string
    cursor?: string
    signal: AbortSignal
    resolve: (page: {
      items: { messageID: string; partID: string; text: string }[]
      nextCursor: string | null
      preparing: boolean
      prepared: number
    }) => void
  }[] = []
  const search = createHistorySearch(
    (input) =>
      new Promise<{
        items: { messageID: string; partID: string; text: string }[]
        nextCursor: string | null
        preparing: boolean
        prepared: number
      }>((resolve) => requests.push({ ...input, resolve })),
    () => {},
  )
  const old = search.start({ query: "old" })
  const current = search.start({ query: "中文" })
  expect(requests[0].signal.aborted).toBe(true)
  requests[0].resolve({
    items: [{ messageID: "old", partID: "old", text: "old" }],
    nextCursor: null,
    preparing: false,
    prepared: 1,
  })
  await old
  requests[1].resolve({ items: [], nextCursor: "next", preparing: false, prepared: 1 })
  await Promise.resolve()
  await Promise.resolve()
  expect(requests[2].cursor).toBe("next")
  requests[2].resolve({
    items: [{ messageID: "message", partID: "part", text: "中文" }],
    nextCursor: "more",
    preparing: false,
    prepared: 1,
  })
  await current
  expect(search.state.items.map((item) => item.partID)).toEqual(["part"])
  const more = search.more()
  requests[3].resolve({
    items: [{ messageID: "message", partID: "part", text: "中文重复" }],
    nextCursor: null,
    preparing: false,
    prepared: 1,
  })
  await more
  expect(search.state.items).toHaveLength(1)
  search.dispose()
})
