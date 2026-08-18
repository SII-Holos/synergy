import { describe, expect, test } from "bun:test"
import { createBoardLoader, type BoardLoaderDeps } from "../../../../src/components/kanban/model/board-loader"
import type { SyncResourceRequest } from "../../../../src/context/sync-resource-freshness"
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
  protects: string[]
  unprotects: string[]
  touches: string[]
  messagePages: { sessionID: string; limit: number }[]
  scopeVersions: Record<string, number>
} {
  const protects: string[] = []
  const unprotects: string[] = []
  const touches: string[] = []
  const messagePages: { sessionID: string; limit: number }[] = []
  const scopeVersions: Record<string, number> = {}
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
    protects,
    unprotects,
    touches,
    messagePages,
    scopeVersions,
    ensureScopeState,
    captureResourceRequest: (_s, sessionID) => ({ sessionID }) as unknown as SyncResourceRequest,
    unprotectMessageBucket: (_s, sessionID) => unprotects.push(sessionID),
    beginContextProjection: () => 1,
    applyResourceResponse: (_s, _sid, _r, _req, _h, apply) => {
      apply()
      return true
    },
    setLatestContextMessage: () => {},
    touchMessageBucket: (_s, sessionID) => touches.push(sessionID),
    protectMessageBucket: (_s, sessionID) => protects.push(sessionID),
    scopeReconnectVersion: (scopeKey) => scopeVersions[scopeKey] ?? 0,
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
  test("load protects the bucket and issues a 200-limit message page", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.load("/a", "s1")
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.protects).toEqual(["s1"])
    expect(deps.messagePages).toEqual([{ sessionID: "s1", limit: 200 }])
  })

  test("syncPanes protects, loads, and deduplicates repeated panes", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.syncPanes([
      { scopeKey: "/a", sessionID: "s1" },
      { scopeKey: "/a", sessionID: "s2" },
      { scopeKey: "/a", sessionID: "s1" },
    ])
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.protects).toEqual(["s1", "s2"])
    // s1 deduplicated: only one messagePage per session
    expect(deps.messagePages.map((p) => p.sessionID).sort()).toEqual(["s1", "s2"])
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

  test("unprotect removes the bucket from the protection set", () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.unprotect("/a", "s1")
    expect(deps.unprotects).toEqual(["s1"])
  })

  test("dispose stops further loads", async () => {
    const deps = makeDeps()
    const loader = createBoardLoader(deps)
    loader.dispose()
    loader.load("/a", "s1")
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.messagePages).toEqual([])
    expect(deps.protects).toEqual([])
  })
})
