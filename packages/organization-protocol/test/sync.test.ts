import { expect, test } from "bun:test"
import { OrganizationSyncProtocol as Sync } from "../src"

const event = Sync.Event.parse({
  type: "message",
  sequence: 1,
  messageID: "message-1",
  role: "assistant",
  createdAt: 1,
  summary: "bounded summary",
  integrity: "a".repeat(64),
})

test("sync batches require strict contiguous positive sequences", () => {
  const batch = Sync.Batch.parse({
    schemaVersion: 1,
    sessionID: "session-1",
    projectID: "project-1",
    bindingEpoch: 1,
    shareGeneration: 1,
    firstSeq: 1,
    lastSeq: 1,
    payloadHash: "b".repeat(64),
    events: [event],
  })
  expect(batch.events).toEqual([event])
  expect(() => Sync.Batch.parse({ ...batch, unknown: true })).toThrow()
  expect(() => Sync.Batch.parse({ ...batch, firstSeq: 0 })).toThrow()
  expect(() => Sync.Batch.parse({ ...batch, lastSeq: 2 })).toThrow()
})

test("sync projections reject oversized summaries and unknown event fields", () => {
  expect(
    Sync.Event.safeParse({
      ...event,
      summary: "x".repeat(32 * 1024 + 1),
    }).success,
  ).toBe(false)
  expect(Sync.Event.safeParse({ ...event, extra: "forged" }).success).toBe(false)
})
