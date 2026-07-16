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
  beforeEach(() => SessionMessageCache.disable(SID))

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
