import { expect, test } from "bun:test"
import { createEventProjection, projectReplayEvent } from "../../src/server/event-projection"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"

const part = (text: string): MessageV2.TextPart => ({
  id: "part",
  messageID: "message",
  sessionID: "session",
  type: "text",
  text,
})
const event = (text: string, delta?: string) => ({
  scopeID: "scope",
  payload: {
    type: "message.part.updated",
    streaming: !!delta,
    epoch: "epoch",
    seq: 12,
    properties: { part: part(text), delta },
  },
})

test("projection replay preserves every state sequence while removing inactive bodies", () => {
  const input = event("x".repeat(1_000_000)).payload
  const replay = projectReplayEvent(input, () => {
    throw new Error("No message header")
  }) as { type: string; epoch: string; seq: number; properties: { summary: unknown; content?: unknown } }
  expect(replay.type).toBe("message.part.summary")
  expect(replay.epoch).toBe(input.epoch)
  expect(replay.seq).toBe(input.seq)
  expect(replay.properties.content).toBeUndefined()
  expect(JSON.stringify(replay).length).toBeLessThan(2048)
  expect(input.properties.part.text.length).toBe(1_000_000)
})

test("unmounted content sends only summaries while preserving its state watermark", () => {
  const projection = createEventProjection(() => {})
  const result = projection.project(event("x".repeat(1_000_000)))
  expect(JSON.stringify(result).length).toBeLessThan(2048)
  expect(result.payload.epoch).toBe("epoch")
  expect(result.payload.seq).toBe(12)
  expect(result.payload.properties.content).toBeUndefined()
})

test("a body subscription establishes a checkpoint before a delta and fences replacement", async () => {
  const sent: unknown[] = []
  const projection = createEventProjection((frame) => sent.push(frame))
  const pending = Promise.withResolvers<{ part: MessageV2.Part; epoch: string; seq: number }>()
  const subscription = { scopeID: "scope", sessionID: "session", messageID: "message", partID: "part", generation: 1 }
  const initial = projection.interests({ parts: [subscription] }, () => pending.promise)
  expect(projection.project(event("ab", "b")).payload.properties.content).toBeUndefined()
  pending.resolve({ part: part("a"), epoch: "epoch", seq: 10 })
  await initial
  const checkpoint = sent[0] as {
    payload: {
      properties: { content: { kind: string; part: MessageV2.TextPart }; summary: { content: { version: string } } }
    }
  }
  expect(checkpoint.payload.properties.content.kind).toBe("checkpoint")
  expect(checkpoint.payload.properties.content.part.text).toBe("ab")
  const delta = projection.project(event("abc", "c")).payload.properties.content
  expect(delta?.kind).toBe("delta")
  expect(delta?.kind === "delta" && delta.baseVersion).toBe(checkpoint.payload.properties.summary.content.version)
  const stale = Promise.withResolvers<{ part: MessageV2.Part; epoch: string; seq: number }>()
  const replacement = projection.interests({ parts: [{ ...subscription, generation: 2 }] }, () => stale.promise)
  await projection.interests({ parts: [] }, () => {
    throw new Error("No read")
  })
  stale.resolve({ part: part("obsolete"), epoch: "epoch", seq: 15 })
  await replacement
  expect(sent).toHaveLength(1)
  projection.dispose()
})

test("cancelled checkpoint batches do not read removed interests and failed reads can retry", async () => {
  const sent: unknown[] = []
  const projection = createEventProjection((frame) => sent.push(frame))
  const interests = Array.from({ length: 8 }, (_, index) => ({
    scopeID: "scope",
    sessionID: "session",
    messageID: "message",
    partID: String(index),
    generation: 1,
  }))
  const gate = Promise.withResolvers<{ part: MessageV2.Part; epoch: string; seq: number }>()
  let reads = 0
  const pending = projection.interests({ parts: interests }, () => {
    reads++
    return gate.promise
  })
  await projection.interests({ parts: [] }, async () => {
    throw new Error("removed")
  })
  gate.resolve({ part: part("old"), epoch: "epoch", seq: 10 })
  await pending
  expect(reads).toBe(4)
  expect(sent).toEqual([])
  await projection.interests({ parts: [interests[0]!] }, async () => {
    throw new Error("temporary")
  })
  await projection.interests({ parts: [interests[0]!] }, async () => ({
    part: { ...part("new"), id: "0" },
    epoch: "epoch",
    seq: 20,
  }))
  expect(sent).toHaveLength(1)
  projection.dispose()
})
