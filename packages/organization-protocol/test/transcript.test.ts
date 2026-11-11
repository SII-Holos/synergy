import { expect, test } from "bun:test"
import { OrganizationSyncProtocol as Sync } from "../src"

test("shared transcript parts retain dialogue independently from bounded summaries", () => {
  const event = {
    type: "part",
    sequence: 2,
    messageID: "message-dialogue",
    partID: "part-dialogue",
    part: { type: "text", content: { kind: "inline", text: "Shared dialogue with its full original content." } },
    integrity: "a".repeat(64),
  } as const
  expect(Sync.Event.parse(event)).toEqual(event)
  expect(Sync.Event.safeParse({ ...event, part: { ...event.part, metadata: { credentials: "private" } } }).success).toBe(false)
})

test("large transcript content uses an authenticated blob reference instead of truncation", () => {
  const event = {
    type: "part",
    sequence: 3,
    messageID: "message-large",
    partID: "part-large",
    part: {
      type: "reasoning",
      content: { kind: "blob", blobID: "transcript-blob", hash: "b".repeat(64), bytes: 1_048_576, mediaType: "text/plain;charset=utf-8" },
    },
    integrity: "c".repeat(64),
  } as const
  expect(Sync.Event.parse(event)).toEqual(event)
  expect(Sync.Event.safeParse({ ...event, part: { type: "text", content: { kind: "inline", text: "字".repeat(65_536) } } }).success).toBe(false)
  expect(Sync.Event.safeParse({ ...event, part: { ...event.part, content: { ...event.part.content, url: "file:///private" } } }).success).toBe(false)
})

test("transcript deletion is explicit and cannot carry replacement content", () => {
  const event = { type: "part", sequence: 4, messageID: "message-removed", partID: "part-removed", removed: true, integrity: "d".repeat(64) } as const
  expect(Sync.Event.parse(event)).toEqual(event)
  expect(Sync.Event.safeParse({ ...event, part: { type: "text", content: { kind: "inline", text: "replacement" } } }).success).toBe(false)
  expect(Sync.Event.safeParse({ ...event, removed: undefined }).success).toBe(false)
})
