import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { Part, Session } from "@ericsanchezok/synergy-sdk/client"

// Regression guard for issue #319: the session.updated / message.part.updated
// store handlers update via `setStore(path, index, reconcile(value))`, not
// whole-object replacement. reconcile diffs structurally and only writes changed
// leaves, so a session.updated that bumps only time.updated (e.g. a blueprint
// node progression) must NOT invalidate memos reading other fields — which is
// what caused the whole timeline to flash.
//
// Fine-grained reactivity requires solid's client build. Under bun's default
// resolution the SSR build is loaded (see the app's known "Client-only API"
// harness limitation), where reconcile is a no-op. We feature-detect the build
// and skip rather than fail there; run `bun test --conditions=browser` to
// exercise these assertions for real.
const CLIENT_BUILD = (() => {
  try {
    const [s, set] = createStore<{ v: { inner: { x: number }; t: string }[] }>({ v: [{ inner: { x: 1 }, t: "A" }] })
    const innerRef = s.v[0].inner
    // Client build reconcile preserves the identity of unchanged nested objects
    // while applying the changed leaf; the SSR build does not.
    set("v", 0, reconcile({ inner: { x: 1 }, t: "B" }))
    return s.v[0].t === "B" && s.v[0].inner === innerRef
  } catch {
    return false
  }
})()

function makeSession(overrides: Record<string, unknown> = {}): Session {
  return {
    id: "ses_a",
    title: "A",
    scope: { id: "scope_1", type: "directory", directory: "/project" },
    time: { created: 1, updated: 1 },
    ...overrides,
  } as unknown as Session
}

function makePart(overrides: Record<string, unknown> = {}): Part {
  return {
    id: "part_1",
    sessionID: "ses_a",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: { status: "running", input: {}, title: "run", time: { start: 1 } },
    ...overrides,
  } as unknown as Part
}

describe.skipIf(!CLIENT_BUILD)("session store reconcile invariants (#319)", () => {
  test("time.updated-only session update does not recompute a title memo", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{ session: Session[] }>({ session: [makeSession()] })

      let runs = 0
      const title = createMemo(() => {
        runs++
        return store.session[0]?.title
      })

      expect(title()).toBe("A")
      expect(runs).toBe(1)
      const scopeRef = store.session[0].scope

      // Mirror the handler: reconcile an info that only bumps time.updated.
      setStore("session", 0, reconcile(makeSession({ time: { created: 1, updated: 999 } })))

      expect(title()).toBe("A")
      expect(runs).toBe(1) // memo NOT recomputed — the #319 flash is gone
      expect(store.session[0].scope).toBe(scopeRef) // unchanged nested identity preserved
      expect(store.session[0].time.updated).toBe(999) // change applied

      dispose()
    })
  })

  test("a real title change does recompute the title memo", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{ session: Session[] }>({ session: [makeSession()] })
      let runs = 0
      const title = createMemo(() => {
        runs++
        return store.session[0]?.title
      })
      expect(title()).toBe("A")

      setStore("session", 0, reconcile(makeSession({ title: "B", time: { created: 1, updated: 2 } })))

      expect(title()).toBe("B")
      expect(runs).toBe(2)
      dispose()
    })
  })

  test("streaming part delta does not recompute a memo reading a stable part field", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{ part: Record<string, Part[]> }>({
        part: { msg_1: [makePart()] },
      })

      let runs = 0
      const callID = createMemo(() => {
        runs++
        return (store.part.msg_1[0] as { callID?: string }).callID
      })

      expect(callID()).toBe("call_1")
      expect(runs).toBe(1)

      // Mirror the handler: reconcile a part whose streamed output advanced.
      setStore(
        "part",
        "msg_1",
        0,
        reconcile(
          makePart({
            state: { status: "running", input: {}, title: "run", time: { start: 1 }, output: "chunk" },
          }),
        ),
      )

      expect(callID()).toBe("call_1")
      expect(runs).toBe(1) // stable field memo not recomputed on every delta
      dispose()
    })
  })
})

// Regression guard for the streaming delta protocol (#350 D1): a
// `message.part.delta` frame appends the increment to the .text leaf of an
// existing text part via produce, so only the text node updates and sibling
// fields keep their identity. A following checkpoint (`message.part.updated`)
// replaces authoritative state.
describe.skipIf(!CLIENT_BUILD)("streaming delta append (#350 D1)", () => {
  function makeTextPart(text: string): Part {
    return {
      id: "part_txt",
      sessionID: "ses_a",
      messageID: "msg_1",
      type: "text",
      text,
      time: { start: 1 },
    } as unknown as Part
  }

  const applyDelta = (setStore: any, delta: string) =>
    setStore(
      "part",
      "msg_1",
      0,
      produce((p: any) => {
        if (typeof p?.text === "string") p.text += delta
      }),
    )

  test("delta frames append to text without touching sibling identity", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{ part: Record<string, Part[]> }>({
        part: { msg_1: [makeTextPart("Hel")] },
      })

      const timeRef = (store.part.msg_1[0] as { time: unknown }).time
      let timeRuns = 0
      const timeMemo = createMemo(() => {
        timeRuns++
        return (store.part.msg_1[0] as { time: unknown }).time
      })
      expect(timeMemo()).toBe(timeRef)

      applyDelta(setStore, "lo")
      applyDelta(setStore, " world")

      expect((store.part.msg_1[0] as { text: string }).text).toBe("Hello world")
      // sibling leaf identity preserved => memos reading .time never recompute
      expect((store.part.msg_1[0] as { time: unknown }).time).toBe(timeRef)
      expect(timeRuns).toBe(1)
      dispose()
    })
  })

  test("checkpoint reconcile replaces authoritative text after deltas", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{ part: Record<string, Part[]> }>({
        part: { msg_1: [makeTextPart("Hel")] },
      })
      applyDelta(setStore, "lo")
      // checkpoint: full-part update reconciles to the server's authoritative text
      setStore("part", "msg_1", 0, reconcile(makeTextPart("Hello there")))
      expect((store.part.msg_1[0] as { text: string }).text).toBe("Hello there")
      dispose()
    })
  })
})
