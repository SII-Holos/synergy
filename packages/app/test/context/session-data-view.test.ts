import { describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

// The app hook reads the shared scope store through useSync(). Substitute a
// plain signal-backed sync object so the hook's memo reactivity can be
// exercised without the full sync runtime.
let dataSignal: ReturnType<typeof createSignal<Record<string, unknown>>>
mock.module("../../src/context/sync", () => ({
  useSync: () => ({
    get data() {
      return dataSignal[0]()
    },
  }),
}))

const { useSessionDataView } = await import("../../src/context/session-data-view")

function storeState() {
  return {
    session: [{ id: "s1" }],
    session_status: { s1: { type: "idle" } },
    session_diff: {},
    message: { s1: [{ id: "m1", sessionID: "s1" }] },
    part: { m1: [{ id: "p1", sessionID: "s1", messageID: "m1" }] },
    permission: {},
    planBlueprintOffer: {
      s1: { key: "offer-key", offer: { noteID: "n1", title: "Offer", key: "offer-key" } },
    },
  }
}

function runWithData(initial: Record<string, unknown>, fn: (view: ReturnType<typeof useSessionDataView>) => void) {
  const [data, setData] = createSignal(initial)
  dataSignal = [data, setData]
  return createRoot((dispose) => {
    const view = useSessionDataView()
    fn(view)
    dispose()
  })
}

describe("useSessionDataView", () => {
  test("exposes session fields through the view accessors", () => {
    runWithData(storeState(), (view) => {
      expect(view().messagesFor("s1")).toHaveLength(1)
      expect(view().partsFor("m1")).toHaveLength(1)
      expect(view().statusFor("s1")).toEqual({ type: "idle" })
      expect(view().sessionFor("s1")?.id).toBe("s1")
      expect(view().planBlueprintOfferFor("s1")?.offer?.title).toBe("Offer")
    })
  })

  test("returns shared empty arrays for missing buckets without throwing", () => {
    runWithData(storeState(), (view) => {
      expect(view().messagesFor("missing")).toEqual([])
      expect(view().partsFor("missing")).toEqual([])
      expect(view().permissionsFor("s1")).toEqual([])
      expect(view().inboxFor("s1")).toEqual([])
      expect(view().todosFor("s1")).toEqual([])
      expect(view().dagNodesFor("s1")).toEqual([])
      expect(view().questionsFor("s1")).toEqual([])
      expect(view().cortexTasks()).toEqual([])
      expect(view().sessionFor("missing")).toBeUndefined()
      expect(view().planBlueprintOfferFor("missing")).toBeUndefined()
    })
  })

  test("survives an empty store", () => {
    runWithData({} as Record<string, unknown>, (view) => {
      expect(view().messagesFor("s1")).toEqual([])
      expect(view().partsFor("m1")).toEqual([])
      expect(view().statusFor("s1")).toBeUndefined()
      expect(view().planBlueprintOfferFor("s1")).toBeUndefined()
    })
  })
})
