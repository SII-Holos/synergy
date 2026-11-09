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

test("shared roots include only their Cortex descendants and completion notifications", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-cortex",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, "session-cortex", { expectedShareGeneration: 0 }))
  const view = await f.run(() => Directory.get(f.credentials.alice, "session-cortex"))
  const root = Sync.Event.parse({
    type: "session",
    sequence: 1,
    session: {
      sessionID: "session-cortex",
      projectID: "project",
      creatorID: "alice",
      driverRuntimeID: "runtime-alice",
      bindingEpoch: 1,
      createdAt: view.createdAt,
      shareGeneration: 1,
    },
  })
  const child = Sync.Event.parse({
    type: "session",
    sequence: 2,
    session: {
      sessionID: "child-cortex",
      rootSessionID: "session-cortex",
      parentSessionID: "session-cortex",
      projectID: "project",
      creatorID: "alice",
      driverRuntimeID: "runtime-alice",
      bindingEpoch: 1,
      createdAt: view.createdAt + 1,
      shareGeneration: 1,
      cortex: {
        taskID: "task-cortex",
        parentSessionID: "session-cortex",
        parentMessageID: "message-parent",
        status: "completed",
        description: "child task",
        startedAt: view.createdAt + 1,
      },
    },
  })
  const cortex = Sync.Event.parse({
    type: "cortex",
    sequence: 3,
    sessionID: "child-cortex",
    taskID: "task-cortex",
    parentSessionID: "session-cortex",
    parentMessageID: "message-parent",
    status: "completed",
    description: "child task",
    startedAt: view.createdAt + 1,
    summary: "done",
    integrity: digest("cortex"),
  })
  const notification = Sync.Event.parse({
    type: "notification",
    sequence: 4,
    sessionID: "session-cortex",
    notificationID: "inbox-notice",
    kind: "cortex-completion",
    taskID: "task-cortex",
    childSessionID: "child-cortex",
    status: "completed",
    createdAt: view.createdAt + 2,
    summary: "done",
    integrity: digest("notification"),
  })
  await f.run(() =>
    Sharing.applyBatch(
      f.credentials.alice,
      batch({
        sessionID: "session-cortex",
        projectID: "project",
        bindingEpoch: 1,
        shareGeneration: 1,
        events: [root, child, cortex, notification],
      }),
    ),
  )
  const page = await f.run(() => Sharing.events(f.credentials.bob, "session-cortex", { limit: 10 }))
  expect(page.items).toEqual([root, child, cortex, notification])

  const independent = Sync.Event.parse({
    ...child,
    sequence: 5,
    session: { ...sessionData(child), sessionID: "independent", rootSessionID: "another-root" },
  })
  await expect(
    f.run(() =>
      Sharing.applyBatch(
        f.credentials.alice,
        batch({
          sessionID: "session-cortex",
          projectID: "project",
          bindingEpoch: 1,
          shareGeneration: 1,
          events: [independent],
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

test("shared search only returns current-generation safe summaries", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-search",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, "session-search", { expectedShareGeneration: 0 }))
  const view = await f.run(() => Directory.get(f.credentials.alice, "session-search"))
  const root = Sync.Event.parse({
    type: "session",
    sequence: 1,
    session: {
      sessionID: "session-search",
      projectID: "project",
      creatorID: "alice",
      driverRuntimeID: "runtime-alice",
      bindingEpoch: 1,
      createdAt: view.createdAt,
      shareGeneration: 1,
    },
  })
  const message = Sync.Event.parse({
    type: "message",
    sequence: 2,
    sessionID: "session-search",
    messageID: "message-search",
    role: "assistant",
    createdAt: view.createdAt,
    summary: "safe searchable result",
    integrity: digest("message-search"),
  })
  await f.run(() =>
    Sharing.applyBatch(
      f.credentials.alice,
      batch({
        sessionID: "session-search",
        projectID: "project",
        bindingEpoch: 1,
        shareGeneration: 1,
        events: [root, message],
      }),
    ),
  )
  const page = await f.run(() => Sharing.search(f.credentials.bob, "session-search", { q: "searchable", limit: 1 }))
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({ sequence: 2, kind: "message", id: "message-search" })
  expect(page.items[0]?.snippet).toContain("searchable")
  expect(
    await f.run(() => Sharing.search(f.credentials.bob, "session-search", { q: "searchable", limit: 32, cursor: 2 })),
  ).toMatchObject({ items: [] })
  await f.run(() => Sharing.unshare(f.credentials.alice, "session-search", { expectedShareGeneration: 1 }))
  await expect(
    f.run(() => Sharing.search(f.credentials.bob, "session-search", { q: "searchable", limit: 32 })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
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

test("shared blobs require the active generation and verify chunked bytes before reads", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-blob",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, "session-blob", { expectedShareGeneration: 0 }))
  const content = new Uint8Array(4 * 1024 * 1024 + 3)
  content.fill(7)
  content[content.length - 1] = 9
  const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex")
  const first = await f.run(() =>
    Sharing.uploadBlob(f.credentials.alice, "session-blob", {
      shareGeneration: 1,
      hash,
      offset: 0,
      totalBytes: content.byteLength,
      bytes: content.subarray(0, 4 * 1024 * 1024),
    }),
  )
  expect(first).toMatchObject({ complete: false, receivedBytes: 4 * 1024 * 1024, nextOffset: 4 * 1024 * 1024 })
  const complete = await f.run(() =>
    Sharing.uploadBlob(f.credentials.alice, "session-blob", {
      shareGeneration: 1,
      hash,
      offset: 4 * 1024 * 1024,
      totalBytes: content.byteLength,
      bytes: content.subarray(4 * 1024 * 1024),
    }),
  )
  expect(complete).toMatchObject({ complete: true, bytes: content.byteLength, receivedBytes: content.byteLength })
  expect(
    await f.run(() => Sharing.downloadBlob(f.credentials.bob, "session-blob", { shareGeneration: 1, hash })),
  ).toEqual(Buffer.from(content))
  await f.run(() => Sharing.unshare(f.credentials.alice, "session-blob", { expectedShareGeneration: 1 }))
  await expect(
    f.run(() => Sharing.getBlobStatus(f.credentials.bob, "session-blob", { shareGeneration: 1, hash })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
})

test("shared blob routes accept authenticated chunks and return bytes only after authorization", async () => {
  await using f = await directoryFixture()
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "session-blob-http",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, "session-blob-http", { expectedShareGeneration: 0 }))

  const bytes = new TextEncoder().encode("blob")
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const headers = {
    ...f.headers("alice"),
    origin: "https://organization.example",
    "x-csrf-token": "f".repeat(64),
    "content-type": "application/octet-stream",
  }
  const upload = await fetch(
    new URL(
      `/org/v1/sessions/session-blob-http/blobs/${hash}?shareGeneration=1&totalBytes=${bytes.byteLength}`,
      f.baseUrl,
    ),
    { method: "PUT", headers, body: Buffer.from(bytes) },
  )
  expect(upload.status).toBe(200)
  expect(Sync.BlobStatus.parse(await upload.json())).toMatchObject({ complete: true, bytes: bytes.byteLength })

  const status = await fetch(new URL(`/org/v1/sessions/session-blob-http/blobs/${hash}?shareGeneration=1`, f.baseUrl), {
    headers: f.headers("bob"),
  })
  expect(status.status).toBe(200)
  expect(Sync.BlobStatus.parse(await status.json()).complete).toBe(true)

  const content = await fetch(
    new URL(`/org/v1/sessions/session-blob-http/blobs/${hash}/content?shareGeneration=1`, f.baseUrl),
    { headers: f.headers("bob") },
  )
  expect(content.status).toBe(200)
  expect(content.headers.get("content-type")).toContain("application/octet-stream")
  expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes)
})
