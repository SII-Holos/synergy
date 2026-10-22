import { expect, spyOn, test } from "bun:test"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import {
  createViewProjection,
  projectViewReplay,
  VIEW_FRAME_LIMIT,
  type ViewEvent,
} from "../../src/server/view-projection"
import { createProjectionCursors } from "../../src/server/projection-cursors"
import { createEventProjection, projectReplayEvent } from "../../src/server/event-projection"

const part = (text: string): MessageV2.TextPart => ({
  id: "part",
  messageID: "message",
  sessionID: "session",
  type: "text",
  text,
})
const event = (text: string, delta?: string) => ({
  scopeID: "scope",
  payload: { type: "message.part.updated", properties: { part: part(text), delta }, streaming: delta !== undefined },
})
const read = async () => ({ part: part("start"), epoch: "epoch", seq: 3 })

test("unsequenced content does not split a contiguous cursor range", () => {
  const sent: ViewEvent[] = []
  const cursors = createProjectionCursors(
    (event) => sent.push(event),
    () => () => {},
  )
  for (let seq = 1; seq <= 20; seq++) {
    cursors.project({
      scopeID: "scope",
      payload: { type: "server.cursor", epoch: "epoch", seq, properties: { epoch: "epoch", fromSeq: seq, toSeq: seq } },
    })
    const content: ViewEvent = {
      scopeID: "scope",
      payload: { type: "message.part.delta", streaming: true, properties: { delta: "text" } },
    }
    expect(cursors.project(content)).toBe(content)
  }
  expect(sent).toHaveLength(0)
  const state: ViewEvent = {
    scopeID: "scope",
    payload: { type: "session.updated", epoch: "epoch", seq: 21, properties: {} },
  }
  expect(cursors.project(state)).toBe(state)
  expect(sent).toMatchObject([{ payload: { seq: 20, properties: { fromSeq: 1, toSeq: 20 } } }])
  cursors.dispose()
})

test("live and replay projections reuse the producer summary with exact JSON byte sizes", async () => {
  let text = ""
  const events = ["\ud83d", "\ude80", '\n"\\', " [report](asset://0123456789abcdef.docx)"].map((delta) => {
    text += delta
    const input = event(text, delta)
    return {
      ...input,
      payload: {
        ...input.payload,
        properties: { ...input.payload.properties, summary: MessageV2.summarizePart(input.payload.properties.part) },
      },
    }
  })
  const final = event(text)
  const finalSummary = MessageV2.summarizePart(final.payload.properties.part)
  const legacy = createEventProjection(() => {})
  const view = createViewProjection(() => {})
  const interests = { parts: [], active: { scopeID: "scope", sessionID: "session", generation: 1 } }
  await legacy.interests(interests, read)
  await view.interests({ ...interests, generation: 1, details: [] }, read)
  using summarize = spyOn(MessageV2, "summarizePart")
  try {
    for (const input of events) {
      const expected = input.payload.properties.summary
      for (const projection of [legacy, view]) {
        const frame = projection.project(input)
        expect(frame?.payload.properties.summary).toMatchObject({
          preview: expected.preview,
          content: { bytes: Buffer.byteLength(JSON.stringify(input.payload.properties.part)) },
        })
      }
      expect(projectViewReplay([input.payload])[0]?.properties.summary).toEqual(expected)
      expect(
        projectReplayEvent(input.payload, () => {
          throw new Error("Unexpected message projection")
        }),
      ).toMatchObject({
        properties: { summary: expected },
      })
    }
    for (const projection of [legacy, view]) {
      const frame = projection.project({
        ...final,
        payload: { ...final.payload, properties: { ...final.payload.properties, summary: finalSummary } },
      })
      expect(frame?.payload.properties.summary).toEqual(finalSummary)
    }
    expect(summarize).not.toHaveBeenCalled()
  } finally {
    legacy.dispose()
    view.dispose()
  }
})

test("authoritative append checkpoints carry metadata and a version anchor without retransmitting text", async () => {
  const projection = createViewProjection(() => {})
  await projection.interests(
    { parts: [], active: { scopeID: "scope", sessionID: "session", generation: 1 }, generation: 1, details: [] },
    read,
  )
  let text = ""
  for (const delta of ["x".repeat(100000), "\ud83d", "\ude80", " done"]) {
    text += delta
    projection.project(event(text, delta))
  }
  const final = event(text)
  final.payload.properties.part.time = { start: 1, end: 2 }
  const frame = projection.project(final)!
  expect(frame.payload.properties.content).toMatchObject({
    kind: "anchor",
    offset: text.length,
    part: { type: "text", time: { start: 1, end: 2 } },
  })
  expect(JSON.stringify(frame)).not.toContain("x".repeat(1000))
  expect(frame.payload.properties.summary).toEqual(MessageV2.summarizePart(final.payload.properties.part))
  const edited = projection.project(event("y" + text.slice(1)))!
  expect(edited.payload.properties.content).toMatchObject({ kind: "reference" })
  projection.dispose()
})
test("unrequested detail and evidence advance the same cursor in live and replay without sending bodies", () => {
  const frames: ViewEvent[] = []
  const projection = createViewProjection((frame) => frames.push(frame))
  const events = ["rollout.updated", "usage.recorded", "execution.updated", "lsp.client.diagnostics"].map(
    (type, i) => ({
      scopeID: "scope",
      payload: { type, epoch: "epoch", seq: i + 1, properties: { value: "secret-body".repeat(1000) } },
    }),
  )
  for (const event of events) expect(projection.project(event)).toBeNull()
  const visible = { scopeID: "scope", payload: { type: "session.status", epoch: "epoch", seq: 5, properties: {} } }
  expect(projection.project(visible)).toEqual(visible)
  expect(frames).toHaveLength(1)
  expect(frames[0].payload.properties).toEqual({ epoch: "epoch", fromSeq: 1, toSeq: 4 })
  expect(JSON.stringify(frames)).not.toContain("secret-body")
  expect(projectViewReplay(events.map((event) => event.payload))).toEqual(frames.map((frame) => frame!.payload))
  projection.dispose()
})

test("cursor ranges preserve gaps, epochs and scopes, flush on deadline, and release their timer", () => {
  const frames: ViewEvent[] = []
  let due: (() => void) | undefined
  const cursors = createProjectionCursors(
    (frame) => frames.push(frame),
    (flush, ms) => {
      expect(ms).toBe(50)
      due = flush
      return () => {
        due = undefined
      }
    },
  )
  const cursor = (scopeID: string, seq: number, epoch = "a"): ViewEvent => ({
    scopeID,
    payload: { type: "server.cursor", epoch, seq, properties: { epoch, fromSeq: seq, toSeq: seq } },
  })
  cursors.project(cursor("one", 1))
  cursors.project(cursor("two", 1))
  cursors.project(cursor("one", 2))
  cursors.project(cursor("one", 4))
  cursors.project(cursor("one", 1, "b"))
  expect(frames.map((frame) => frame.payload.properties)).toEqual([
    { epoch: "a", fromSeq: 1, toSeq: 2 },
    { epoch: "a", fromSeq: 4, toSeq: 4 },
  ])
  due!()
  expect(frames.slice(2).map((frame) => [frame.scopeID, frame.payload.epoch])).toEqual([
    ["two", "a"],
    ["one", "b"],
  ])
  expect(due).toBeUndefined()
  for (let i = 0; i < 129; i++) cursors.project(cursor(String(i), 1))
  expect(frames).toHaveLength(5)
  cursors.dispose()
  expect(due).toBeUndefined()
  expect(frames).toHaveLength(5)
  const closing = createProjectionCursors(
    () => closing.dispose(),
    (flush) => {
      due = flush
      return () => {
        due = undefined
      }
    },
  )
  closing.project(cursor("one", 1))
  closing.project(cursor("one", 3))
  expect(due).toBeUndefined()
})
test("append traffic hashes only checkpoints and its byte work is proportional to new text", async () => {
  const frames: unknown[] = []
  const projection = createViewProjection((frame) => frames.push(frame))
  await projection.interests(
    { parts: [], active: { scopeID: "scope", sessionID: "session", generation: 1 }, generation: 1, details: [] },
    read,
  )
  const summarize = spyOn(MessageV2, "summarizePart")
  let text = "",
    bytes = 0
  try {
    for (let i = 0; i < 200; i++) {
      const delta = "abcdefgh".repeat(128)
      text += delta
      const frame = projection.project(event(text, delta))!
      bytes += JSON.stringify(frame).length
      expect(JSON.stringify(frame).length).toBeLessThanOrEqual(VIEW_FRAME_LIMIT)
    }
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(1)
    expect(bytes).toBeLessThan(text.length * 2)
    const complete = projection.project(event(text))!
    expect(complete.payload.type).toBe("message.part.summary")
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(2)
  } finally {
    summarize.mockRestore()
    projection.dispose()
  }
})
test("an oversized body is a version reference, never an oversized frame or truncated text", async () => {
  const sent: unknown[] = []
  const projection = createViewProjection((frame) => sent.push(frame))
  await projection.interests(
    {
      generation: 1,
      parts: [{ scopeID: "scope", sessionID: "session", messageID: "message", partID: "part", generation: 1 }],
      details: [],
    },
    async () => ({ part: part("x".repeat(200000)), epoch: "epoch", seq: 3 }),
  )
  expect(JSON.stringify(sent[0]).length).toBeLessThan(VIEW_FRAME_LIMIT)
  expect((sent[0] as { payload: { properties: { content?: unknown } } }).payload.properties.content).toMatchObject({
    kind: "reference",
  })
  projection.dispose()
})

test("unsubscribed streaming bodies emit no content or synthetic versions", () => {
  const projection = createViewProjection(() => {})
  const summarize = spyOn(MessageV2, "summarizePart")
  try {
    expect(projection.project(event("private stream", " stream"))).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
    expect(projection.project(event("complete"))?.payload.type).toBe("message.part.summary")
  } finally {
    summarize.mockRestore()
    projection.dispose()
  }
})

test("the same append workload removes at least eighty percent of compatibility checkpoint bytes", async () => {
  const legacy = createEventProjection(() => {})
  const projected = createViewProjection(() => {})
  const interest = { parts: [], active: { scopeID: "scope", sessionID: "session", generation: 1 } }
  await legacy.interests(interest, read)
  await projected.interests({ ...interest, generation: 1, details: [] }, read)
  let tick = 1000,
    before = 0,
    after = 0,
    text = ""
  const clock = spyOn(Date, "now").mockImplementation(() => tick)
  try {
    for (let index = 0; index < 300; index++) {
      const delta = "delta".repeat(200)
      text += delta
      tick += 100
      const value = event(text, delta)
      before += Buffer.byteLength(JSON.stringify(legacy.project(value)))
      after += Buffer.byteLength(JSON.stringify(projected.project(value)))
    }
    expect(after).toBeLessThan(before * 0.2)
  } finally {
    clock.mockRestore()
    legacy.dispose()
    projected.dispose()
  }
})

test("removing a pending detail aborts its lease without waiting for unrelated part reads", async () => {
  let signal: AbortSignal | undefined
  let opened!: () => void
  const started = new Promise<void>((resolve) => (opened = resolve))
  let finish!: () => void
  const gate = new Promise<void>((resolve) => (finish = resolve))
  const projection = createViewProjection(() => {}, [
    {
      kind: "test",
      eventType: "test.updated",
      async open(_interest, _send, abort) {
        signal = abort
        opened()
        await gate
        return { project() {}, dispose() {} }
      },
    },
  ])
  const opening = projection.interests(
    { generation: 1, parts: [], details: [{ kind: "test", scopeID: "scope", sessionID: "session", generation: 1 }] },
    read,
  )
  await started
  const pending = projection.interests(
    {
      generation: 2,
      parts: [{ scopeID: "scope", sessionID: "session", messageID: "message", partID: "part", generation: 2 }],
      details: [],
    },
    async () => {
      await gate
      return read()
    },
  )
  expect(signal?.aborted).toBe(true)
  finish()
  await Promise.all([opening, pending])
  projection.dispose()
})

test("joining an already large stream anchors once and then sends only append work", async () => {
  const frames: Array<import("../../src/server/view-projection").ViewEvent> = []
  const projection = createViewProjection((frame) => frames.push(frame))
  let text = "large ".repeat(40000)
  await projection.interests(
    {
      generation: 1,
      parts: [{ scopeID: "scope", sessionID: "session", messageID: "message", partID: "part", generation: 1 }],
      details: [],
    },
    async () => ({ part: part(text), epoch: "epoch", seq: 0 }),
  )
  expect(frames[0].payload.properties.content).toMatchObject({ kind: "reference" })
  const summarize = spyOn(MessageV2, "summarizePart")
  try {
    for (let i = 0; i < 100; i++) {
      const delta = "new ".repeat(64)
      text += delta
      const frame = projection.project(event(text, delta))!
      expect(frame.payload.properties.content).toMatchObject({
        kind: "append",
        offset: text.length - delta.length,
        revision: i + 1,
      })
    }
    expect(summarize).not.toHaveBeenCalled()
  } finally {
    summarize.mockRestore()
    projection.dispose()
  }
})

test("a retained immutable body resumes its stream without retransmitting the checkpoint", async () => {
  const body = part("cached body"),
    summary = MessageV2.summarizePart(body)
  const sent: Array<import("../../src/server/view-projection").ViewEvent> = []
  const projection = createViewProjection((frame) => sent.push(frame))
  await projection.interests(
    {
      generation: 1,
      parts: [
        {
          scopeID: "scope",
          sessionID: "session",
          messageID: "message",
          partID: "part",
          generation: 1,
          version: summary.content.version,
        },
      ],
      details: [],
    },
    async () => ({ part: body, epoch: "epoch", seq: 0 }),
  )
  expect(sent[0].payload.properties.content).toBeUndefined()
  expect(sent[0].payload.properties.stream).toMatchObject({ offset: body.text.length, revision: 0 })
  expect(projection.project(event(body.text + " next", " next"))?.payload.properties.content).toMatchObject({
    kind: "append",
    offset: body.text.length,
  })
  projection.dispose()
})

test("overflow while opening a detail releases its pending work and requests only that subscription again", async () => {
  const gate = Promise.withResolvers<void>()
  let disposed = 0
  let aborted: AbortSignal | undefined
  const sent: Array<import("../../src/server/view-projection").ViewEvent> = []
  const projection = createViewProjection(
    (frame) => sent.push(frame),
    [
      {
        kind: "execution",
        eventType: "execution.updated",
        async open(_interest, _send, signal) {
          aborted = signal
          await gate.promise
          return {
            project() {},
            dispose() {
              disposed++
            },
          }
        },
      },
    ],
  )
  const opening = projection.interests(
    {
      generation: 1,
      parts: [],
      details: [{ kind: "execution", scopeID: "scope", sessionID: "session", generation: 7 }],
    },
    read,
  )
  for (let i = 0; i < 65; i++)
    projection.project({
      scopeID: "scope",
      payload: { type: "execution.updated", properties: { sessionID: "session", revision: i } },
    })
  expect(aborted?.aborted).toBe(true)
  expect(sent).toHaveLength(1)
  expect(sent[0].payload).toMatchObject({
    type: "server.view.patch",
    properties: { sessionID: "session", generation: 7, revision: 0, previousRevision: 0, patches: [] },
  })
  gate.resolve()
  await opening
  expect(disposed).toBe(1)
  projection.dispose()
})
