import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useFilteredList } from "../../src/hooks/use-filtered-list"

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for filtered list")
}

test("defers async item loading until the first input", async () => {
  const calls: string[] = []
  let dispose = () => {}
  const list = createRoot((rootDispose) => {
    dispose = rootDispose
    return useFilteredList<{ id: string }>({
      items: async (filter) => {
        calls.push(filter)
        return [{ id: filter }]
      },
      key: (item) => item.id,
      deferInitialLoad: true,
    })
  })

  try {
    await Bun.sleep(10)
    expect(calls).toEqual([])

    list.onInput("")
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([""])
  } finally {
    dispose()
  }
})
