import { expect, test } from "bun:test"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { digest } from "../src/auth/secret"
import { directoryFixture } from "./support/session-directory"

test("shared message windows page by chronology and parts finish independently within the replay watermark", async () => {
  await using f = await directoryFixture()
  const sessionID = "shared-window"
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, { sessionID, projectID: "project", runtimeID: "runtime-alice" }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, sessionID, { expectedShareGeneration: 0 }))
  const session = await f.run(() => Directory.get(f.credentials.alice, sessionID))
  const events: Sync.Event[] = [
    Sync.Event.parse({
      type: "session",
      sequence: 1,
      session: {
        sessionID,
        projectID: "project",
        creatorID: "alice",
        driverRuntimeID: "runtime-alice",
        bindingEpoch: 1,
        createdAt: session.createdAt,
        shareGeneration: 1,
      },
    }),
  ]
  for (const value of [3, 1, 5, 2, 4])
    events.push(
      Sync.Event.parse({
        type: "message",
        sequence: events.length + 1,
        messageID: `message-${value}`,
        role: "user",
        createdAt: value,
        summary: "",
        integrity: digest(`message-${value}`),
      }),
    )
  for (const id of ["part-c", "part-a", "part-b"])
    events.push(
      Sync.Event.parse({
        type: "part",
        sequence: events.length + 1,
        messageID: "message-5",
        partID: id,
        part: { type: "text", content: { kind: "inline", text: id } },
        integrity: digest(id),
      }),
    )
  await f.run(() =>
    Sharing.applyBatch(f.credentials.alice, {
      schemaVersion: 1,
      sessionID,
      projectID: "project",
      bindingEpoch: 1,
      shareGeneration: 1,
      firstSeq: 1,
      lastSeq: events.length,
      events,
      payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: events.length, events })),
    }),
  )
  const first = await f.run(() => Sharing.messages(f.credentials.bob, sessionID, { limit: 2 }))
  expect(first.items.map((item) => item.messageID)).toEqual(["message-4", "message-5"])
  expect(first.watermark).toBe(events.length)
  const older = await f.run(() =>
    Sharing.messages(f.credentials.bob, sessionID, { limit: 2, cursor: first.cursor, watermark: first.watermark }),
  )
  expect(older.items.map((item) => item.messageID)).toEqual(["message-2", "message-3"])
  const parts = await f.run(() =>
    Sharing.parts(f.credentials.bob, sessionID, { messageID: "message-5", limit: 2, watermark: first.watermark }),
  )
  expect(parts.items.map((part) => part.partID)).toEqual(["part-a", "part-b"])
  expect(parts.complete).toBe(false)
  const final = await f.run(() =>
    Sharing.parts(f.credentials.bob, sessionID, {
      messageID: "message-5",
      limit: 2,
      cursor: parts.cursor,
      watermark: first.watermark,
    }),
  )
  expect(final.items.map((part) => part.partID)).toEqual(["part-c"])
  expect(final.complete).toBe(true)
  await expect(
    f.run(() => Sharing.parts(f.credentials.bob, sessionID, { messageID: "unknown", limit: 2 })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  await expect(
    f.run(() => Sharing.messages(f.credentials.bob, sessionID, { limit: 2, cursor: "not-a-cursor" })),
  ).rejects.toThrow()
  await f.run(() => Sharing.unshare(f.credentials.alice, sessionID, { expectedShareGeneration: 1 }))
  await expect(f.run(() => Sharing.messages(f.credentials.bob, sessionID, { limit: 2 }))).rejects.toMatchObject({
    data: { code: "NOT_FOUND" },
  })
})
