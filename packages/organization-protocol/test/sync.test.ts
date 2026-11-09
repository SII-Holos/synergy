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

test("sync projections carry Cortex descendants and authenticated blob references", () => {
  const child = Sync.Event.parse({
    type: "session",
    sequence: 2,
    session: {
      sessionID: "child-session",
      rootSessionID: "root-session",
      parentSessionID: "root-session",
      projectID: "project-1",
      creatorID: "account-1",
      driverRuntimeID: "runtime-1",
      bindingEpoch: 1,
      createdAt: 2,
      shareGeneration: 1,
      cortex: {
        taskID: "cortex-task",
        parentSessionID: "root-session",
        parentMessageID: "message-1",
        status: "completed",
        description: "bounded child",
        startedAt: 2,
      },
    },
  })
  const blob = Sync.Event.parse({
    type: "blob",
    sequence: 3,
    sessionID: "child-session",
    blobID: "blob-1",
    kind: "tool-observation",
    mediaType: "text/plain",
    bytes: 3,
    hash: "c".repeat(64),
    state: "available",
  })
  expect(child.type).toBe("session")
  expect(blob.type).toBe("blob")
})
