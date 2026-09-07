import { describe, expect, test } from "bun:test"
import { createBoardLoader, type BoardLoaderDeps } from "../../../../src/components/kanban/model/board-loader"
import type { SyncResourceRequest } from "../../../../src/context/sync-resource-freshness"
import type { SessionPartSnapshotRequest } from "../../../../src/context/session-part-snapshot-freshness"
import { createScopeRetention } from "../../../../src/context/scope-retention"
import { planMessagePageApply } from "../../../../src/context/session-message-page"

function message(id: string, created: number) {
  return { id, time: { created }, role: "assistant", rootID: id } as any
}

type FakeStore = {
  message: Record<string, unknown>
  messageWindow: Record<string, unknown>
  part: Record<string, unknown>
}

function makeDeps(overrides: Partial<BoardLoaderDeps> = {}): BoardLoaderDeps & {
  touches: string[]
  messagePages: { sessionID: string; limit: number }[]
  scopeVersions: Record<string, number>
  bucketSnapshots: Set<string>
  partActions: Record<string, "apply" | "preserve" | "retry">
} {
  const touches: string[] = []
  const messagePages: { sessionID: string; limit: number }[] = []
  const scopeVersions: Record<string, number> = {}
  const bucketSnapshots = new Set<string>()
  const partActions: Record<string, "apply" | "preserve" | "retry"> = {}
  const stores = new Map<string, FakeStore>()
  const ensureScopeState = (scopeKey: string) => {
    let store = stores.get(scopeKey)
    if (!store) {
      store = { message: {}, messageWindow: {}, part: {} }
      stores.set(scopeKey, store)
    }
    const setter = (_path: string, _key: string, _value: unknown) => {}
    return [store, setter]
  }
  return {
    touches,
    messagePages,
    scopeVersions,
    bucketSnapshots,
    partActions,
    ensureScopeState,
    retainScopeState: () => ({ release() {} }),
    captureResourceRequest: (_s, sessionID) => ({ sessionID }) as unknown as SyncResourceRequest,
    capturePartSnapshotRequest: (_s, _sid) => ({ generation: 1, revisions: new Map() }) as SessionPartSnapshotRequest,
    partSnapshotAction: (_s, _sid, messageID) => partActions[messageID] ?? "apply",
    beginContextProjection: () => 1,
    applyResourceResponse: (_s, _sid, _r, _req, _h, apply) => {
      apply()
      return true
    },
    setLatestContextMessage: () => {},
    touchMessageBucket: (_s, sessionID) => touches.push(sessionID),
    scopeReconnectVersion: (scopeKey) => scopeVersions[scopeKey] ?? 0,
    hasBucketSnapshot: (_s, sessionID) => bucketSnapshots.has(sessionID),
    messagePage: async (input) => {
      messagePages.push({ sessionID: input.sessionID, limit: input.limit })
      return {
        data: {
          items: [{ info: message(input.sessionID + "-m1", 100), parts: [] }],
          referencedRoots: [],
          nextCursor: null,
          hasMore: false,
          total: 1,
        },
      }
    },
    scopeRequest: (scopeKey) => ({ directory: scopeKey }),
    plan: planMessagePageApply,
    reconcile: (value) => value,
    ...overrides,
  }
}

describe("createBoardLoader", () => {
  test("load issues a 200-limit message page", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.load("/a", "s1")
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages).toEqual([{ sessionID: "s1", limit: 200 }])
  })

  test("syncPanes loads and deduplicates repeated panes", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.syncPanes([
      { scopeKey: "/a", sessionID: "s1" },
      { scopeKey: "/a", sessionID: "s2" },
      { scopeKey: "/a", sessionID: "s1" },
    ])
    await new Promise((r) => setTimeout(r, 10))
    // s1 deduplicated: only one messagePage per session
    expect(deps.messagePages.map((p) => p.sessionID).sort()).toEqual(["s1", "s2"])
  })

  test("syncPanes skips already-loaded panes on navigation updates", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    await new Promise((r) => setTimeout(r, 10))
    const first = deps.messagePages.length

    // Same pane set again: phase is now ready and the bucket exists, so no refetch.
    deps.bucketSnapshots.add("s1")
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages.length).toBe(first)
  })

  test("syncPanes forces a reload when the scope reconnect version bumps", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    deps.scopeVersions["/a"] = 1
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    await new Promise((r) => setTimeout(r, 10))
    const first = deps.messagePages.length

    // Reconnect bumps the version for the same scope → force reload of s1.
    deps.scopeVersions["/a"] = 2
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages.length).toBeGreaterThan(first)
    expect(deps.messagePages.at(-1)?.sessionID).toBe("s1")
  })

  test("syncPanes reloads a pane that left the board and rejoined", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.syncPanes([
      { scopeKey: "/a", sessionID: "s1" },
      { scopeKey: "/a", sessionID: "s2" },
    ])
    await new Promise((r) => setTimeout(r, 10))
    const s2Pages = deps.messagePages.filter((p) => p.sessionID === "s2").length
    expect(s2Pages).toBe(1)

    // s2 leaves the board; when it rejoins it must be refetched because its
    // bucket may have been LRU-evicted while away (no protection set).
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    loader.syncPanes([
      { scopeKey: "/a", sessionID: "s1" },
      { scopeKey: "/a", sessionID: "s2" },
    ])
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages.filter((p) => p.sessionID === "s2").length).toBe(2)
  })

  test("syncPanes refetches a ready pane whose bucket was LRU-evicted", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    await new Promise((r) => setTimeout(r, 10))
    const first = deps.messagePages.length

    // The loader still reports "ready", but the global-sync LRU evicted the
    // snapshot while the pane was away; syncPanes must refetch instead of
    // leaving the pane on a stale ready state.
    deps.bucketSnapshots.add("s1") // simulate apply having happened before eviction
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages.length).toBe(first)

    // Now the bucket is gone: refetch must happen even though phase is ready.
    deps.bucketSnapshots.delete("s1")
    loader.syncPanes([{ scopeKey: "/a", sessionID: "s1" }])
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages.length).toBe(first + 1)
    expect(deps.messagePages.at(-1)?.sessionID).toBe("s1")
  })

  test("dispose stops further loads", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.dispose()
    loader.load("/a", "s1")
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages).toEqual([])
  })
})

test("visible board Scopes survive the inactive budget and release with their final pane", async () => {
  const resident = new Set<string>()
  const retention = createScopeRetention((key) => resident.delete(key))
  const held: { resolve: (value: {}) => void; promise: Promise<{}> }[] = []
  const signals = new Map<string, AbortSignal>()
  const deps = makeDeps({
    ensureScopeState: (key) => {
      resident.add(key)
      retention.touch(key)
      return [{}, () => {}]
    },
    retainScopeState: (key) => {
      const release = retention.retain(key)
      resident.add(key)
      return { release }
    },
    messagePage: (input, options) => {
      signals.set(input.sessionID, options.signal)
      let resolve!: (value: {}) => void
      const promise = new Promise<{}>((done) => (resolve = done))
      held.push({ promise, resolve })
      return promise
    },
  })
  const loader = createBoardLoader(deps)
  const panes = Array.from({ length: 12 }, (_, i) => ({ scopeKey: "/scope-" + i, sessionID: "session-" + i }))
  const other = retention.retain(panes[0]!.scopeKey)
  try {
    loader.syncPanes([...panes, { scopeKey: panes[0]!.scopeKey, sessionID: "second-pane" }])
    expect(panes.every((pane) => resident.has(pane.scopeKey))).toBe(true)
    for (let i = 0; i < 20; i++) deps.ensureScopeState("/background-" + i)
    expect(panes.every((pane) => resident.has(pane.scopeKey))).toBe(true)
    loader.syncPanes([{ scopeKey: panes[0]!.scopeKey, sessionID: "second-pane" }])
    expect(resident.has(panes[0]!.scopeKey)).toBe(true)
    expect(panes.slice(1).every((pane) => !resident.has(pane.scopeKey))).toBe(true)
    expect(panes.every((pane) => signals.get(pane.sessionID)?.aborted)).toBe(true)
    expect(signals.get("second-pane")?.aborted).toBe(false)
    expect(loader.state(panes[1]!.scopeKey, panes[1]!.sessionID).phase).toBe("idle")
    loader.syncPanes([])
    expect(signals.get("second-pane")?.aborted).toBe(true)
    expect(resident.has(panes[0]!.scopeKey)).toBe(true)
    other()
    expect(resident.has(panes[0]!.scopeKey)).toBe(false)
    loader.syncPanes(panes)
    loader.dispose()
    expect(panes.every((pane) => !resident.has(pane.scopeKey))).toBe(true)
    expect(panes.every((pane) => signals.get(pane.sessionID)?.aborted)).toBe(true)
  } finally {
    loader.dispose()
    other()
    for (const request of held.values()) request.resolve({})
    await Promise.all(Array.from(held.values(), (request) => request.promise))
  }
})
