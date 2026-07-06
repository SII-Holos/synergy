import { describe, expect, test, beforeEach } from "bun:test"
import { SessionMessageCache } from "../../src/session/message-cache"
import type { MessageV2 } from "../../src/session/message-v2"

const SID = "ses_cache"

function userMsg(id: string): MessageV2.WithParts {
  return { info: { id, sessionID: SID, role: "user" } as any, parts: [] }
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
})
