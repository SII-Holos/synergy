import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createLibraryCollection } from "../../../src/components/library/library-collection"

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

test("search results belong to their query, including late failures and refresh recovery", async () => {
  const old = Promise.withResolvers<string[]>()
  let fail = false
  const mounted = createRoot((dispose) => {
    const [key, setKey] = createSignal("old")
    return {
      dispose,
      setKey,
      collection: createLibraryCollection(key, async (query) => {
        if (query === "old") return old.promise
        if (fail) throw new Error("offline")
        return [query]
      }),
    }
  })
  try {
    mounted.setKey("new")
    await settle()
    expect(mounted.collection.items()).toEqual(["new"])
    old.reject(new Error("obsolete request"))
    await settle()
    expect(mounted.collection.error()).toBeUndefined()
    fail = true
    await mounted.collection.refresh()
    expect(mounted.collection.items()).toEqual(["new"])
    expect(mounted.collection.error()).toBeInstanceOf(Error)
    mounted.setKey("different")
    expect(mounted.collection.items()).toEqual([])
    await settle()
    expect(mounted.collection.items()).toEqual([])
    fail = false
    await mounted.collection.refresh()
    expect(mounted.collection.items()).toEqual(["different"])
  } finally {
    mounted.dispose()
  }
})

test("confirmed removals invalidate older refreshes and survive a failed recovery request", async () => {
  const pending = Promise.withResolvers<string[]>()
  let calls = 0
  const mounted = createRoot((dispose) => ({
    dispose,
    collection: createLibraryCollection(
      () => "same",
      async () => {
        if (++calls === 1) return ["first", "second"]
        if (calls === 2) return pending.promise
        throw new Error("Refresh unavailable")
      },
    ),
  }))
  try {
    await settle()
    const refresh = mounted.collection.refresh()
    await settle()
    mounted.collection.discard((item) => item === "first")
    await mounted.collection.refresh()
    expect(mounted.collection.items()).toEqual(["second"])
    pending.resolve(["first", "second"])
    await refresh
    expect(mounted.collection.items()).toEqual(["second"])
  } finally {
    mounted.dispose()
  }
})
