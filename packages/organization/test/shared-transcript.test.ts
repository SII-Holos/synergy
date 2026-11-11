import { expect, test } from "bun:test"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { directoryFixture } from "./support/session-directory"

test("authorized transcript snapshots converge latest parts and fence revoked generations", async () => {
  await using f = await directoryFixture()
  await f.run(() => Directory.reservePrivate(f.credentials.alice, { sessionID: "transcript", projectID: "project", runtimeID: "runtime-alice" }))
  const session = await f.run(() => Directory.get(f.credentials.alice, "transcript"))
  await f.run(() => Sharing.share(f.credentials.alice, session.sessionID, { expectedShareGeneration: 0 }))
  const events: Sync.Event[] = [
    { type: "session", sequence: 1, session: { sessionID: session.sessionID, projectID: session.projectID, creatorID: session.creatorID, driverRuntimeID: session.driverRuntimeID, bindingEpoch: 1, createdAt: session.createdAt, shareGeneration: 1 } },
    { type: "message", sequence: 2, messageID: "message", role: "assistant", createdAt: 1, summary: "", integrity: "a".repeat(64) },
    { type: "part", sequence: 3, messageID: "message", partID: "part", part: { type: "text", content: { kind: "inline", text: "first version" } }, integrity: "b".repeat(64) },
    { type: "part", sequence: 4, messageID: "message", partID: "part", part: { type: "text", content: { kind: "inline", text: "complete shared dialogue" } }, integrity: "c".repeat(64) },
  ]
  await f.run(() => Sharing.applyBatch(f.credentials.alice, {
    schemaVersion: 1, sessionID: session.sessionID, projectID: session.projectID, bindingEpoch: 1, shareGeneration: 1,
    firstSeq: 1, lastSeq: 4, events, payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 4, events })),
  }))
  const snapshot = await f.run(() => Sharing.snapshot(f.credentials.bob, session.sessionID, { limit: 100 }))
  expect(snapshot.watermark).toBe(4)
  expect(snapshot.items.filter((event) => event.type === "part").map((event) => JSON.stringify(event))).toEqual([JSON.stringify(events[3])])
  expect((await f.run(() => Sharing.search(f.credentials.bob, session.sessionID, { q: "complete shared", limit: 4 }))).items).toHaveLength(1)
  await f.run(() => Sharing.unshare(f.credentials.alice, session.sessionID, { expectedShareGeneration: 1 }))
  await expect(f.run(() => Sharing.snapshot(f.credentials.bob, session.sessionID, { limit: 100 }))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  await f.run(() => Sharing.share(f.credentials.alice, session.sessionID, { expectedShareGeneration: 2 }))
  expect((await f.run(() => Sharing.snapshot(f.credentials.bob, session.sessionID, { limit: 100 }))).items).toEqual([])
})
