import { expect, test } from "bun:test"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { digest } from "../src/auth/secret"
import { sharedProducerFixture } from "./support/shared-producer"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"

test("directory presentation uses shared native observations and removes their content when private", async () => {
  await using f = await sharedProducerFixture()
  const sessionID = "presentation"
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, { sessionID, projectID: "project", runtimeID: "runtime-alice" }),
  )
  const initial = await f.run(() => Directory.get(f.credentials.alice, sessionID))
  expect(initial).not.toHaveProperty("title")
  expect(initial.runtime).toMatchObject({ runtimeID: "runtime-alice", state: "offline", connectionEpoch: 1 })
  await f.run(() => Sharing.share(f.credentials.alice, sessionID, { expectedShareGeneration: 0 }))
  const status = { type: "paused" as const, since: 8, reason: "aborted" as const, controlVersion: 3, observedAt: 10 }
  const events = [
    Sync.Event.parse({
      type: "session",
      sequence: 1,
      session: {
        sessionID,
        projectID: "project",
        creatorID: "alice",
        driverRuntimeID: "runtime-alice",
        bindingEpoch: 1,
        createdAt: initial.createdAt,
        shareGeneration: 1,
        title: "Review shared files",
        status,
      },
    }),
  ]
  await f.run(() =>
    f.sync({
      schemaVersion: 1,
      sessionID,
      projectID: "project",
      bindingEpoch: 1,
      shareGeneration: 1,
      firstSeq: 1,
      lastSeq: 1,
      events,
      payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 1, events })),
    }),
  )
  const shared = await f.run(() => Directory.get(f.credentials.bob, sessionID))
  expect(shared.title).toBe("Review shared files")
  expect(shared.status).toEqual(status)
  expect(shared.sync).toMatchObject({ nextSeq: 2, shareGeneration: 1, shareState: "shared" })
  expect((await f.run(() => Directory.list(f.credentials.bob, "project", { limit: 2 }))).items).toEqual([shared])
  await f.run(() => Sharing.unshare(f.credentials.alice, sessionID, { expectedShareGeneration: 1 }))
  const privateView = await f.run(() => Directory.get(f.credentials.alice, sessionID))
  expect(privateView.title).toBeUndefined()
  expect(privateView.status).toBeUndefined()
  expect(privateView.sync?.shareState).toBe("private")
})
