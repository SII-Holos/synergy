import { expect, test } from "bun:test"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { authorize } from "../src/authorization"
import { digest } from "../src/auth/secret"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { sharedProducerFixture } from "./support/shared-producer"

test("execution projection windows center and page only current acknowledged shared versions", async () => {
  await using f = await sharedProducerFixture()
  const sessionID = "ses_projected_tool"
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID,
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  const session = await f.run(() => Directory.get(f.credentials.alice, sessionID))
  await f.run(() => Sharing.share(f.credentials.alice, sessionID, { expectedShareGeneration: 0 }))
  const events: Sync.Event[] = [
    {
      type: "session",
      sequence: 1,
      session: {
        sessionID,
        projectID: session.projectID,
        creatorID: session.creatorID,
        driverRuntimeID: session.driverRuntimeID,
        bindingEpoch: session.bindingEpoch,
        createdAt: session.createdAt,
        shareGeneration: 1,
        title: "Acknowledged title",
      },
    },
  ]
  for (let index = 1; index <= 7; index++) {
    const messageID = `msg_${index}`
    events.push({
      type: "message",
      sequence: events.length + 1,
      messageID,
      role: "user",
      createdAt: index,
      summary: `Message ${index}`,
      integrity: "a".repeat(64),
    })
    events.push({
      type: "part",
      sequence: events.length + 1,
      messageID,
      partID: `prt_${index}`,
      part: { type: "text", origin: "user", content: { kind: "inline", text: `Current shared ${index}` } },
      integrity: "b".repeat(64),
    })
  }
  events.push({
    type: "part",
    sequence: events.length + 1,
    messageID: "msg_4",
    partID: "prt_4",
    part: { type: "text", origin: "user", content: { kind: "inline", text: "Revised current shared 4" } },
    integrity: "c".repeat(64),
  })
  const canonical = events.map((event) => Sync.Event.parse(event))
  await f.run(() =>
    f.sync({
      schemaVersion: 1,
      sessionID,
      projectID: "project",
      bindingEpoch: 1,
      shareGeneration: 1,
      firstSeq: 1,
      lastSeq: events.length,
      events: canonical,
      payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: events.length, events: canonical })),
    }),
  )
  const read = (query: { limit: number; offset: number; around?: string }) =>
    f.run(() =>
      Sharing.readForExecution({
        query: { targetSessionID: sessionID, ...query },
        signal: AbortSignal.timeout(2_000),
        authorize: async () => (await authorize(f.credentials.bob, "session.read", { sessionID })).session,
      }),
    )
  const around = await read({ limit: 3, offset: 0, around: "msg_4" })
  expect(around.title).toBe("Acknowledged title")
  expect(around.watermark).toBe(events.length)
  expect(around.items.map(({ message }) => message.messageID)).toEqual(["msg_5", "msg_4", "msg_3"])
  expect(around.items[1].parts[0].part).toEqual({
    type: "text",
    origin: "user",
    content: { kind: "inline", text: "Revised current shared 4" },
  })
  expect(around.partial).toBe(true)
  expect((await read({ limit: 3, offset: 0, around: "msg_1" })).items.map(({ message }) => message.messageID)).toEqual([
    "msg_3",
    "msg_2",
    "msg_1",
  ])
  expect((await read({ limit: 3, offset: 0, around: "msg_7" })).items.map(({ message }) => message.messageID)).toEqual([
    "msg_7",
    "msg_6",
    "msg_5",
  ])
  expect((await read({ limit: 2, offset: 2 })).items.map(({ message }) => message.messageID)).toEqual([
    "msg_5",
    "msg_4",
  ])
  expect((await read({ limit: 50, offset: 0 })).partial).toBe(false)
  expect((await read({ limit: 0, offset: 0 })).items).toEqual([])
  await expect(read({ limit: 3, offset: 0, around: "msg_unpublished" })).rejects.toMatchObject({
    data: { code: "NOT_FOUND" },
  })
  await f.run(() => Sharing.unshare(f.credentials.alice, sessionID, { expectedShareGeneration: 1 }))
  await expect(read({ limit: 3, offset: 0 })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
})
