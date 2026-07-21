import { describe, expect, test, beforeEach } from "bun:test"
import { SessionMessageCache } from "../../src/session/message-cache"
import type { MessageV2 } from "../../src/session/message-v2"

const SID = "ses_cache"

function userMsg(id: string, created = 0): MessageV2.WithParts {
  return { info: { id, sessionID: SID, role: "user", time: { created } } as any, parts: [] }
}
function part(id: string, messageID: string, text = ""): MessageV2.Part {
  return { id, sessionID: SID, messageID, type: "text", text } as any
}

describe("SessionMessageCache", () => {
  beforeEach(() => {
    SessionMessageCache.disable(SID)
    SessionMessageCache.resetStatsForTest()
  })

  test("reports bounded footprint and hit/miss counters", () => {
    SessionMessageCache.enable(SID)
    expect(SessionMessageCache.get(SID)).toBeUndefined()
    SessionMessageCache.set(SID, [userMsg("msg_1")])

    const entry = SessionMessageCache.stats().entries.find((item) => item.sessionID === SID)
    expect(SessionMessageCache.get(SID)).toBeDefined()
    expect(SessionMessageCache.stats()).toMatchObject({
      activeCount: 1,
      entryCount: 1,
      hits: 1,
      misses: 1,
      evictions: 0,
      protectedOverbudget: 0,
    })
    expect(entry?.estimatedBytes).toBeGreaterThan(0)
    expect(SessionMessageCache.stats().totalBytes).toBe(entry!.estimatedBytes)
  })

  test("upsert paths do not inflate hit/miss counters", () => {
    SessionMessageCache.enable(SID)
    SessionMessageCache.set(SID, [userMsg("msg_1")])
    SessionMessageCache.resetStatsForTest()
    SessionMessageCache.upsertMessage(SID, { id: "msg_2", sessionID: SID, role: "user" } as any)
    SessionMessageCache.upsertPart(SID, part("prt_1", "msg_1", "a"))
    expect(SessionMessageCache.stats()).toMatchObject({ hits: 0, misses: 0 })
    expect(SessionMessageCache.get(SID)).toBeDefined()
    expect(SessionMessageCache.stats().hits).toBe(1)
  })

  test("get returns undefined outside the active window", () => {
    SessionMessageCache.set(SID, [userMsg("msg_1")])
    expect(SessionMessageCache.get(SID)).toBeUndefined()
  })

  test("set/get within the window; disable clears", () => {
    SessionMessageCache.enable(SID)
    SessionMessageCache.set(SID, [userMsg("msg_1")])
    expect(SessionMessageCache.get(SID)?.length).toBe(1)
    SessionMessageCache.disable(SID)
    expect(SessionMessageCache.get(SID)).toBeUndefined()
  })

  test("upsertMessage appends in id order and replaces by id", () => {
    SessionMessageCache.enable(SID)
    SessionMessageCache.set(SID, [userMsg("msg_2")])
    SessionMessageCache.upsertMessage(SID, { id: "msg_1", sessionID: SID, role: "user" } as any)
    SessionMessageCache.upsertMessage(SID, { id: "msg_3", sessionID: SID, role: "assistant" } as any)
    expect(SessionMessageCache.get(SID)!.map((m) => m.info.id)).toEqual(["msg_1", "msg_2", "msg_3"])
    // replace existing
    SessionMessageCache.upsertMessage(SID, { id: "msg_2", sessionID: SID, role: "assistant" } as any)
    expect(SessionMessageCache.get(SID)!.find((m) => m.info.id === "msg_2")!.info.role).toBe("assistant")
  })

  test("upsertMessage preserves creation order around legacy stable delivery ids", () => {
    SessionMessageCache.enable(SID)
    const legacyID = `msg_${"f".repeat(26)}`
    const currentID = "msg_f667e6d9d001JelluOI960TfF4"
    SessionMessageCache.set(SID, [userMsg(legacyID, 1)])

    SessionMessageCache.upsertMessage(SID, userMsg(currentID, 2).info)

    expect(SessionMessageCache.get(SID)!.map((message) => message.info.id)).toEqual([legacyID, currentID])
  })

  test("upsertPart inserts and replaces within the target message", () => {
    SessionMessageCache.enable(SID)
    SessionMessageCache.set(SID, [userMsg("msg_1")])
    SessionMessageCache.upsertPart(SID, part("prt_1", "msg_1", "a"))
    SessionMessageCache.upsertPart(SID, part("prt_2", "msg_1", "b"))
    expect(SessionMessageCache.get(SID)![0].parts.map((p) => p.id)).toEqual(["prt_1", "prt_2"])
    SessionMessageCache.upsertPart(SID, part("prt_1", "msg_1", "A"))
    expect((SessionMessageCache.get(SID)![0].parts[0] as any).text).toBe("A")
  })

  test("upsertPart for an unknown message invalidates (bail to disk)", () => {
    SessionMessageCache.enable(SID)
    SessionMessageCache.set(SID, [userMsg("msg_1")])
    SessionMessageCache.upsertPart(SID, part("prt_1", "msg_missing"))
    expect(SessionMessageCache.get(SID)).toBeUndefined()
  })

  test("maintenance is immutable: a prior snapshot is not mutated", () => {
    SessionMessageCache.enable(SID)
    const initial = [userMsg("msg_1")]
    SessionMessageCache.set(SID, initial)
    const snapshot = SessionMessageCache.get(SID)!
    const snapshotParts = snapshot[0].parts
    SessionMessageCache.upsertPart(SID, part("prt_1", "msg_1"))
    // the earlier snapshot and its parts array keep their identity/content
    expect(snapshot[0].parts).toBe(snapshotParts)
    expect(snapshotParts.length).toBe(0)
    // while the live cache advanced
    expect(SessionMessageCache.get(SID)![0].parts.length).toBe(1)
  })

  test("maintenance is a no-op outside the window", () => {
    SessionMessageCache.upsertMessage(SID, { id: "msg_1", sessionID: SID, role: "user" } as any)
    expect(SessionMessageCache.get(SID)).toBeUndefined()
  })

  test("shrinks a populated cache to the completed compaction working set", () => {
    const root = userMsg("msg_root", 1)
    root.info = { ...root.info, isRoot: true, rootID: root.info.id } as MessageV2.User
    root.parts = [{ ...part("prt_compact", root.info.id), type: "compaction", auto: true } as MessageV2.Part]
    const old = userMsg("msg_old", 2)
    const firstSummary: MessageV2.WithParts = {
      info: {
        id: "msg_summary_1",
        sessionID: SID,
        role: "assistant",
        parentID: root.info.id,
        rootID: root.info.id,
        summary: true,
        finish: "stop",
        time: { created: 3, completed: 3 },
      } as MessageV2.Assistant,
      parts: [],
    }
    const continuation = userMsg("msg_continuation", 4)
    const latestSummary: MessageV2.WithParts = {
      info: {
        ...firstSummary.info,
        id: "msg_summary_2",
        time: { created: 5, completed: 5 },
      } as MessageV2.Assistant,
      parts: [],
    }

    SessionMessageCache.enable(SID)
    SessionMessageCache.set(SID, [root, old, firstSummary, continuation, latestSummary])

    const cached = SessionMessageCache.get(SID)!
    expect(cached.map((message) => message.info.id)).toEqual([
      root.info.id,
      firstSummary.info.id,
      latestSummary.info.id,
    ])
    expect(cached[1].info.includeInContext).toBe(false)
  })

  test("shrinks when an incremental compaction summary completes", () => {
    const root = userMsg("msg_root", 1)
    root.info = { ...root.info, isRoot: true, rootID: root.info.id } as MessageV2.User
    const old = userMsg("msg_old", 2)
    const summary: MessageV2.WithParts = {
      info: {
        id: "msg_summary",
        sessionID: SID,
        role: "assistant",
        parentID: root.info.id,
        rootID: root.info.id,
        summary: true,
        time: { created: 3 },
      } as MessageV2.Assistant,
      parts: [],
    }

    SessionMessageCache.enable(SID)
    SessionMessageCache.set(SID, [root, old, summary])
    SessionMessageCache.upsertPart(SID, {
      ...part("prt_compact", root.info.id),
      type: "compaction",
      auto: true,
    } as MessageV2.Part)
    expect(SessionMessageCache.get(SID)!.map((message) => message.info.id)).toEqual([
      root.info.id,
      old.info.id,
      summary.info.id,
    ])

    SessionMessageCache.upsertMessage(SID, {
      ...summary.info,
      finish: "stop",
      time: { created: 3, completed: 4 },
    } as MessageV2.Assistant)

    expect(SessionMessageCache.get(SID)!.map((message) => message.info.id)).toEqual([root.info.id, summary.info.id])
  })

  test("evicts the least-recently-used session when over the byte budget", () => {
    const A = "ses_evict_a"
    const B = "ses_evict_b"
    const previous = process.env.SYNERGY_SESSION_CACHE_MAX_BYTES
    // Tiny budget so a single populated session already approaches it.
    process.env.SYNERGY_SESSION_CACHE_MAX_BYTES = "300"
    try {
      const big = (sid: string): MessageV2.WithParts => ({
        info: { id: "msg_1", sessionID: sid, role: "user" } as any,
        parts: [{ id: "prt_1", sessionID: sid, messageID: "msg_1", type: "text", text: "x".repeat(250) } as any],
      })
      SessionMessageCache.enable(A)
      SessionMessageCache.enable(B)
      SessionMessageCache.set(A, [big(A)])
      expect(SessionMessageCache.get(A)).toBeDefined()
      // Populating B pushes total over budget; A is the LRU and must be evicted,
      // while B (just written) is protected and stays resident.
      SessionMessageCache.set(B, [big(B)])
      expect(SessionMessageCache.get(B)).toBeDefined()
      expect(SessionMessageCache.get(A)).toBeUndefined()
      expect(SessionMessageCache.stats().evictions).toBe(1)
      expect(SessionMessageCache.stats().protectedOverbudget).toBeGreaterThanOrEqual(1)
      // A is still active, so a fresh read repopulates it transparently.
      SessionMessageCache.set(A, [big(A)])
      expect(SessionMessageCache.get(A)).toBeDefined()
    } finally {
      SessionMessageCache.disable(A)
      SessionMessageCache.disable(B)
      if (previous === undefined) delete process.env.SYNERGY_SESSION_CACHE_MAX_BYTES
      else process.env.SYNERGY_SESSION_CACHE_MAX_BYTES = previous
    }
  })
})
