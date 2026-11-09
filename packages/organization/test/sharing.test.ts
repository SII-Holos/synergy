import { expect, test } from "bun:test"
import {
  OrganizationSyncProtocol as Sync,
  OrganizationSessionProtocol as Session,
} from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { directoryFixture } from "./support/session-directory"

function sessionData(event: Sync.Event) {
  if (event.type !== "session") throw new Error("Expected a session projection event")
  return event.session
}

function batch(input: {
  sessionID: string
  projectID: string
  bindingEpoch: number
  shareGeneration: number
  events: Sync.Event[]
}): Sync.Batch {
  const firstSeq = input.events[0]!.sequence
  const lastSeq = input.events.at(-1)!.sequence
  return Sync.Batch.parse({
    schemaVersion: 1,
    sessionID: input.sessionID,
    projectID: input.projectID,
    bindingEpoch: input.bindingEpoch,
    shareGeneration: input.shareGeneration,
    firstSeq,
    lastSeq,
    payloadHash: digest(JSON.stringify({ firstSeq, lastSeq, events: input.events })),
    events: input.events,
  })
}

test("sharing uses generation CAS and exposes only committed safe projections", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-share",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )

  await expect(
    f.run(() => Sharing.share(f.credentials.bob, "session-share", { expectedShareGeneration: 0 })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  await expect(
    f.run(() => Sharing.share(f.credentials.alice, "session-share", { expectedShareGeneration: 1 })),
  ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT", currentRevision: 0 } })

  const shared = await f.run(() => Sharing.share(f.credentials.alice, "session-share", { expectedShareGeneration: 0 }))
  expect(shared).toMatchObject({
    sessionID: "session-share",
    shareState: "shared",
    shareGeneration: 1,
    bindingEpoch: 1,
    nextSeq: 1,
    syncState: "pending",
  })
  expect((await f.run(() => Directory.get(f.credentials.bob, "session-share"))).shareState).toBe("shared")
  const sessionView = await f.run(() => Directory.get(f.credentials.alice, "session-share"))

  const event = Sync.Event.parse({
    type: "session",
    sequence: 1,
    session: {
      sessionID: "session-share",
      projectID: "project",
      creatorID: "alice",
      driverRuntimeID: "runtime-alice",
      bindingEpoch: 1,
      createdAt: sessionView.createdAt,
      shareGeneration: 1,
    },
  })
  const first = batch({
    sessionID: "session-share",
    projectID: "project",
    bindingEpoch: 1,
    shareGeneration: 1,
    events: [event],
  })
  const ack = await f.run(() => Sharing.applyBatch(f.credentials.alice, first))
  expect(ack).toMatchObject({ nextSeq: 2, syncState: "synced", shareGeneration: 1 })
  expect(await f.run(() => Sharing.applyBatch(f.credentials.alice, first))).toMatchObject({
    ...ack,
    nextSeq: 2,
  })
  const secondEvent = Sync.Event.parse({
    type: "message",
    sequence: 2,
    messageID: "message-share",
    role: "user",
    createdAt: sessionView.createdAt,
    summary: "safe summary",
    integrity: digest("message-share"),
  })
  await f.run(() =>
    Sharing.applyBatch(
      f.credentials.alice,
      batch({
        sessionID: "session-share",
        projectID: "project",
        bindingEpoch: 1,
        shareGeneration: 1,
        events: [secondEvent],
      }),
    ),
  )
  expect(await f.run(() => Sharing.events(f.credentials.bob, "session-share", { limit: 1 }))).toEqual({
    sessionID: "session-share",
    shareGeneration: 1,
    nextSeq: 3,
    items: [event],
    cursor: 1,
  })
  expect(await f.run(() => Sharing.events(f.credentials.bob, "session-share", { limit: 1, cursor: 1 }))).toEqual({
    sessionID: "session-share",
    shareGeneration: 1,
    nextSeq: 3,
    items: [secondEvent],
  })

  const gap = Sync.Event.parse({ ...event, sequence: 4 })
  await expect(
    f.run(() =>
      Sharing.applyBatch(
        f.credentials.alice,
        batch({
          sessionID: "session-share",
          projectID: "project",
          bindingEpoch: 1,
          shareGeneration: 1,
          events: [gap],
        }),
      ),
    ),
  ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT", currentRevision: 3 } })

  await expect(
    f.run(() => Sharing.unshare(f.credentials.bob, "session-share", { expectedShareGeneration: 1 })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  const privateView = await f.run(() =>
    Sharing.unshare(f.credentials.alice, "session-share", { expectedShareGeneration: 1 }),
  )
  expect(privateView).toMatchObject({ shareState: "private", shareGeneration: 2, syncState: "blocked" })
  await expect(f.run(() => Sharing.events(f.credentials.bob, "session-share", { limit: 10 }))).rejects.toMatchObject({
    data: { code: "NOT_FOUND" },
  })

  const reshared = await f.run(() =>
    Sharing.share(f.credentials.alice, "session-share", { expectedShareGeneration: 2 }),
  )
  expect(reshared.shareGeneration).toBe(3)
  await expect(
    f.run(() => Sharing.applyBatch(f.credentials.alice, { ...first, shareGeneration: 1 })),
  ).rejects.toMatchObject({ data: { code: "SHARE_REVOKED" } })
})

test("sharing rejects forged payload hashes and non-session projection metadata", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-integrity",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, "session-integrity", { expectedShareGeneration: 0 }))
  const sessionView = await f.run(() => Directory.get(f.credentials.alice, "session-integrity"))
  const event = Sync.Event.parse({
    type: "session",
    sequence: 1,
    session: {
      sessionID: "session-integrity",
      projectID: "project",
      creatorID: "alice",
      driverRuntimeID: "runtime-alice",
      bindingEpoch: 1,
      createdAt: sessionView.createdAt,
      shareGeneration: 1,
    },
  })
  const forged = batch({
    sessionID: "session-integrity",
    projectID: "project",
    bindingEpoch: 1,
    shareGeneration: 1,
    events: [event],
  })
  await expect(
    f.run(() => Sharing.applyBatch(f.credentials.alice, { ...forged, payloadHash: "0".repeat(64) })),
  ).rejects.toMatchObject({
    data: { code: "INVALID_REQUEST" },
  })
  await expect(
    f.run(() =>
      Sharing.applyBatch(
        f.credentials.alice,
        batch({
          sessionID: "session-integrity",
          projectID: "project",
          bindingEpoch: 1,
          shareGeneration: 1,
          events: [
            Sync.Event.parse({
              ...event,
              session: { ...sessionData(event), creatorID: "bob" },
            }),
          ],
        }),
      ),
    ),
  ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
})

test("shared event pages validate cursors and bounded limits", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-page",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, "session-page", { expectedShareGeneration: 0 }))
  const state = await f.run(() => Sharing.get(f.credentials.alice, "session-page"))
  expect(Sync.Share.parse(state).shareGeneration).toBe(1)
  expect(Session.View.safeParse(state).success).toBe(false)
  await expect(f.run(() => Sharing.events(f.credentials.alice, "session-page", { limit: 0 }))).rejects.toThrow()
  await expect(
    f.run(() => Sharing.events(f.credentials.alice, "session-page", { limit: 1, cursor: 99 })),
  ).rejects.toMatchObject({
    data: { code: "REVISION_CONFLICT" },
  })
})

test("sharing routes preserve browser CSRF checks and generated projection responses", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-http",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  const headers = {
    ...f.headers("alice"),
    origin: "https://organization.example",
    "x-csrf-token": "f".repeat(64),
    "content-type": "application/json",
  }
  const share = await fetch(new URL("/org/v1/sessions/session-http/share", f.baseUrl), {
    method: "PUT",
    headers,
    body: JSON.stringify({ expectedShareGeneration: 0 }),
  })
  expect(share.status).toBe(200)
  expect(Sync.Share.parse(await share.json()).shareGeneration).toBe(1)
  const missingCsrf = await fetch(new URL("/org/v1/sessions/session-http/share", f.baseUrl), {
    method: "DELETE",
    headers: { ...headers, "x-csrf-token": "" },
    body: JSON.stringify({ expectedShareGeneration: 1 }),
  })
  expect(missingCsrf.status).toBe(403)
  const state = await f.request("bob", "/sessions/session-http/share")
  expect(state.status).toBe(200)
  expect(Sync.Share.parse(await state.json()).shareState).toBe("shared")
})
