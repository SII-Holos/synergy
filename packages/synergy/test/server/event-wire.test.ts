import { describe, expect, test, beforeEach } from "bun:test"
import { EventWire } from "../../src/server/event-wire"

function partUpdated(part: any, delta?: string) {
  return {
    type: "message.part.updated" as const,
    streaming: delta !== undefined,
    properties: { part, delta },
  }
}

const textPart = (id: string, text: string) => ({
  id,
  type: "text",
  sessionID: "ses_1",
  messageID: "msg_1",
  text,
})

describe("EventWire encoder", () => {
  let wire: EventWire.Encoder
  beforeEach(() => {
    wire = EventWire.createEncoder()
  })

  test("first delta for a part checkpoints (returns full payload)", () => {
    const ev = partUpdated(textPart("prt_1", "Hello"), "Hello")
    const out = wire.deltaPayload(ev, 1000)
    expect(out).toBe(ev) // same reference => send full
  })

  test("subsequent deltas within the interval become compact delta frames", () => {
    const p = textPart("prt_1", "Hello")
    wire.deltaPayload(partUpdated(p, "Hello"), 1000) // checkpoint
    const out = wire.deltaPayload(partUpdated({ ...p, text: "Hello world" }, " world"), 1200)
    expect(out).not.toBe(partUpdated(p))
    expect((out as EventWire.DeltaFrame).type).toBe("message.part.delta")
    expect((out as EventWire.DeltaFrame).properties).toEqual({
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      kind: "text",
      delta: " world",
    })
  })

  test("re-checkpoints after the interval elapses", () => {
    const p = textPart("prt_1", "a")
    wire.deltaPayload(partUpdated(p, "a"), 1000) // checkpoint @1000
    const mid = wire.deltaPayload(partUpdated({ ...p, text: "ab" }, "b"), 1500)
    expect((mid as EventWire.DeltaFrame).type).toBe("message.part.delta")
    const stillDelta = wire.deltaPayload(partUpdated({ ...p, text: "abc" }, "c"), 2000)
    expect((stillDelta as EventWire.DeltaFrame).type).toBe("message.part.delta")
    const cp = wire.deltaPayload(partUpdated({ ...p, text: "abcd" }, "d"), 6000) // >= CHECKPOINT_MS later
    expect(cp).toBe(cp) // full payload returned
    expect((cp as any).type).toBe("message.part.updated")
  })

  test("terminal write (no delta) sends full and frees throttle state", () => {
    const p = textPart("prt_1", "done")
    wire.deltaPayload(partUpdated(p, "done"), 1000) // checkpoint
    const terminal = { type: "message.part.updated", streaming: false, properties: { part: p } }
    const out = wire.deltaPayload(terminal as any, 1100)
    expect(out).toBe(terminal)
    // after terminal, throttle is cleared: a brand-new stream on the same id checkpoints again
    const next = wire.deltaPayload(partUpdated(p, "done"), 1150)
    expect(next).toBe(next)
    expect((next as any).type).toBe("message.part.updated")
  })

  test("tool parts are never delta-encoded (they stream full, throttled elsewhere)", () => {
    const toolPart = { id: "prt_2", type: "tool", sessionID: "ses_1", messageID: "msg_1", state: { raw: "{" } }
    // tool updates never carry a `delta`, so they always pass through as full
    const ev = { type: "message.part.updated", streaming: true, properties: { part: toolPart } }
    const out = wire.deltaPayload(ev as any, 1000)
    expect(out).toBe(ev)
  })

  test("non-part events pass through unchanged", () => {
    const ev = { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }
    const out = wire.deltaPayload(ev as any, 1000)
    expect(out).toBe(ev)
  })
})
