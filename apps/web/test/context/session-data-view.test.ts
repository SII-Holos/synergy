import { describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

// The app hook reads the shared scope store through useSync() and the
// eviction-independent runtime index through useGlobalSync(). Substitute plain
// signal-backed objects so the hook's memo reactivity can be exercised without
// the full sync runtime.
let dataSignal: ReturnType<typeof createSignal<Record<string, unknown>>>
let runtimeSignal: ReturnType<typeof createSignal<Record<string, unknown>>>
mock.module("../../src/context/sync", () => ({
  useSync: () => ({
    get data() {
      return dataSignal[0]()
    },
  }),
}))
mock.module("../../src/context/global-sync", () => ({
  useGlobalSync: () => ({
    get sessionStatus() {
      return runtimeSignal[0]().sessionStatus
    },
    get permissions() {
      return runtimeSignal[0]().permissions
    },
    get questions() {
      return runtimeSignal[0]().questions
    },
  }),
}))

const { useSessionDataView } = await import("../../src/context/session-data-view")

function storeState() {
  return {
    session: [{ id: "s1" }],
    session_diff: {},
    message: { s1: [{ id: "m1", sessionID: "s1" }] },
    part: { m1: [{ id: "p1", sessionID: "s1", messageID: "m1" }] },
    planBlueprintOffer: {
      s1: { key: "offer-key", offer: { noteID: "n1", title: "Offer", key: "offer-key" } },
    },
  }
}

function runtimeState() {
  return {
    sessionStatus: { s1: { type: "idle" } },
    permissions: {},
    questions: {},
  }
}

function runWithData(
  initial: Record<string, unknown>,
  fn: (view: ReturnType<typeof useSessionDataView>) => void,
  runtime: Record<string, unknown> = runtimeState(),
) {
  const [data, setData] = createSignal(initial)
  dataSignal = [data, setData]
  const [runtimeValue, setRuntime] = createSignal(runtime)
  runtimeSignal = [runtimeValue, setRuntime]
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
    runWithData(
      {} as Record<string, unknown>,
      (view) => {
        expect(view().messagesFor("s1")).toEqual([])
        expect(view().partsFor("m1")).toEqual([])
        expect(view().statusFor("s1")).toBeUndefined()
        expect(view().planBlueprintOfferFor("s1")).toBeUndefined()
      },
      { sessionStatus: {}, permissions: {}, questions: {} },
    )
  })

  test("reads runtime state from the global index, not the scope store", () => {
    runWithData(storeState(), (view) => {
      expect(view().statusFor("s1")).toEqual({ type: "idle" })
      expect(view().statusFor("missing")).toBeUndefined()
      // The runtime index keeps only non-idle sessions, so a session the index
      // dropped reads as undefined while the scope store still holds it.
      const current = runtimeSignal[0]()
      current.sessionStatus = {}
      expect(view().statusFor("s1")).toBeUndefined()
    })
  })

  test("sessionFor reads the current session list through a stable store reference", () => {
    runWithData(storeState(), (view) => {
      expect(view().sessionFor("s1")?.id).toBe("s1")
      // The shared scope store is a stable proxy: updates mutate the existing
      // object (setStore), they never replace the `data` reference. A view
      // created once must observe the new session list at call time.
      const current = dataSignal[0]()
      current.session = [{ id: "s2" }]
      expect(view().sessionFor("s1")).toBeUndefined()
      expect(view().sessionFor("s2")?.id).toBe("s2")
    })
  })
})
