import { expect, test } from "bun:test"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { sharedProducerFixture } from "./support/shared-producer"
import { digest } from "../src/auth/secret"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { organizationOpenApi } from "../src/http"
import { OrganizationApiTokens as Tokens } from "../src/auth/api-tokens"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationStoragePath as Keys } from "../src/storage/path"

test("shared task metadata pages use a fixed checkpoint and catch up later native events without exposing results", async () => {
  await using f = await sharedProducerFixture()
  await f.run(async () => {
    await Directory.reservePrivate(f.credentials.alice, {
      sessionID: "task-root",
      projectID: "project",
      runtimeID: "runtime-alice",
    })
    const root = await Directory.get(f.credentials.alice, "task-root")
    await Sharing.share(f.credentials.alice, root.sessionID, { expectedShareGeneration: 0 })
    const projection = {
      projectID: root.projectID,
      creatorID: root.creatorID,
      driverRuntimeID: root.driverRuntimeID,
      bindingEpoch: 1,
      shareGeneration: 1,
      createdAt: root.createdAt,
    }
    const events: Sync.Event[] = [
      { type: "session", sequence: 1, session: { ...projection, sessionID: root.sessionID } },
    ]
    for (let index = 0; index < 70; index++) {
      const sessionID = `child-${String(index).padStart(2, "0")}`
      const cortex = {
        taskID: `task-${index}`,
        parentSessionID: root.sessionID,
        parentMessageID: "root-message",
        status: "completed" as const,
        description: `Task ${index}`,
        startedAt: index + 1,
        visibility: index === 69 ? ("hidden" as const) : ("visible" as const),
      }
      events.push({
        type: "session",
        sequence: events.length + 1,
        session: { ...projection, sessionID, rootSessionID: root.sessionID, parentSessionID: root.sessionID, cortex },
      })
      const { visibility: _visibility, ...safe } = cortex
      events.push({
        type: "cortex",
        sequence: events.length + 1,
        sessionID,
        ...safe,
        summary: "Unrequested full task result",
        integrity: "a".repeat(64),
      })
    }
    const apply = (input: Sync.Event[]) => {
      const batch = input.map((event) => Sync.Event.parse(event))
      return f.sync({
        schemaVersion: 1,
        sessionID: root.sessionID,
        projectID: root.projectID,
        bindingEpoch: 1,
        shareGeneration: 1,
        firstSeq: batch[0]!.sequence,
        lastSeq: batch.at(-1)!.sequence,
        events: batch,
        payloadHash: digest(
          JSON.stringify({ firstSeq: batch[0]!.sequence, lastSeq: batch.at(-1)!.sequence, events: batch }),
        ),
      })
    }
    await apply(events)
    const first = await Sharing.tasks(f.credentials.reader, root.sessionID, { limit: 16 })
    expect(first.watermark).toBe(141)
    expect(first.items).toHaveLength(16)
    expect(JSON.stringify(first)).not.toContain("Unrequested full task result")
    const client = createOrganizationClient({ baseUrl: f.baseUrl, headers: f.headers("reader") })
    expect(
      (await client.orgSessionTranscript.tasks({ sessionID: root.sessionID, limit: 16 }, { throwOnError: true })).data,
    ).toEqual(first)
    const specs = await organizationOpenApi()
    expect(specs.paths?.["/org/v1/sessions/{sessionID}/sync/tasks"]?.get?.operationId).toBe(
      "orgSessionTranscript.tasks",
    )
    await expect(
      Sharing.tasks(f.credentials.reader, root.sessionID, { cursor: first.cursor, sourceSessionID: "child-00" }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect(
      (await client.orgSessionSync.messages({ sessionID: root.sessionID, cursor: first.cursor })).response.status,
    ).toBe(400)
    expect((await Sharing.tasks(f.credentials.admin, root.sessionID, { limit: 16 })).items).toEqual(first.items)
    await expect(Sharing.tasks(f.credentials.outsider, root.sessionID, {})).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
    await Storage.write(Keys.deployment(), {
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    })
    const issued = await Tokens.create(f.credentials.reader, {
      requestID: "task-token",
      projectID: "project",
      label: "Task reader",
      operations: ["sessions.read"],
      expiresAt: Date.now() + 60_000,
    })
    const external = createOrganizationClient({
      baseUrl: f.baseUrl,
      headers: { authorization: `Bearer ${issued.token}` },
    })
    expect(
      (await external.orgSessionTranscript.tasks({ sessionID: root.sessionID, limit: 16 }, { throwOnError: true }))
        .data,
    ).toEqual(first)
    await Tokens.revoke(f.credentials.reader, issued.metadata.tokenID, { expectedRevision: 1 })
    expect((await external.orgSessionTranscript.tasks({ sessionID: root.sessionID, limit: 16 })).response.status).toBe(
      401,
    )
    let page = first
    const ids = first.items.map((item) => item.sessionID)
    while (page.cursor) {
      page = await Sharing.tasks(f.credentials.reader, root.sessionID, { cursor: page.cursor, limit: 16 })
      expect(page.watermark).toBe(first.watermark)
      ids.push(...page.items.map((item) => item.sessionID))
    }
    expect(ids).toHaveLength(69)
    expect(new Set(ids).size).toBe(69)
    const changed = {
      taskID: "task-0",
      parentSessionID: root.sessionID,
      parentMessageID: "root-message",
      status: "running" as const,
      description: "Changed after the first checkpoint",
      startedAt: 1,
    }
    await apply([
      {
        type: "session",
        sequence: 142,
        session: {
          ...projection,
          sessionID: "child-00",
          rootSessionID: root.sessionID,
          parentSessionID: root.sessionID,
          cortex: changed,
        },
      },
      {
        type: "cortex",
        sequence: 143,
        sessionID: "child-00",
        ...changed,
        summary: "Another unrequested result",
        integrity: "b".repeat(64),
      },
    ])
    expect((await Sharing.tasks(f.credentials.reader, root.sessionID, { limit: 1 })).items[0]?.description).toBe(
      changed.description,
    )
    expect(
      (await Sharing.tasks(f.credentials.reader, root.sessionID, { watermark: first.watermark, limit: 1 })).items[0]
        ?.description,
    ).toBe("Task 0")
    await Sharing.unshare(f.credentials.alice, root.sessionID, { expectedShareGeneration: 1 })
    await expect(Sharing.tasks(f.credentials.reader, root.sessionID, { cursor: first.cursor })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
  })
}, 15_000)

test("an empty filtered task page retains its continuation and restart preserves exact checkpoint authority", async () => {
  await using f = await sharedProducerFixture()
  await f.run(async () => {
    await Directory.reservePrivate(f.credentials.alice, {
      sessionID: "filtered-root",
      projectID: "project",
      runtimeID: "runtime-alice",
    })
    const root = await Directory.get(f.credentials.alice, "filtered-root")
    await Sharing.share(f.credentials.alice, root.sessionID, { expectedShareGeneration: 0 })
    const projection = {
      projectID: root.projectID,
      creatorID: root.creatorID,
      driverRuntimeID: root.driverRuntimeID,
      bindingEpoch: 1,
      shareGeneration: 1,
      createdAt: root.createdAt,
    }
    const events: Sync.Event[] = [
      { type: "session", sequence: 1, session: { ...projection, sessionID: root.sessionID } },
    ]
    for (let index = 0; index < 132; index++) {
      const sessionID = `child-${String(index).padStart(3, "0")}`
      const cortex = {
        taskID: `task-${index}`,
        parentSessionID: root.sessionID,
        parentMessageID: "root-message",
        status: "completed" as const,
        description: `Task ${index}`,
        startedAt: index + 1,
        visibility: index < 130 ? ("hidden" as const) : ("visible" as const),
      }
      events.push(
        Sync.Event.parse({
          type: "session",
          sequence: events.length + 1,
          session: { ...projection, sessionID, rootSessionID: root.sessionID, parentSessionID: root.sessionID, cortex },
        }),
      )
      const { visibility: _visibility, ...safe } = cortex
      events.push(
        Sync.Event.parse({
          type: "cortex",
          sequence: events.length + 1,
          sessionID,
          ...safe,
          summary: "Private task output is not a catalog field",
          integrity: "a".repeat(64),
        }),
      )
    }
    for (let offset = 0; offset < events.length; offset += 128) {
      const batch = events.slice(offset, offset + 128).map((event) => Sync.Event.parse(event))
      const firstSeq = batch[0]!.sequence
      const lastSeq = batch.at(-1)!.sequence
      await f.sync({
        schemaVersion: 1,
        sessionID: root.sessionID,
        projectID: root.projectID,
        bindingEpoch: 1,
        shareGeneration: 1,
        firstSeq,
        lastSeq,
        events: batch,
        payloadHash: digest(JSON.stringify({ firstSeq, lastSeq, events: batch })),
      })
    }
  })
  const first = await f.run(() => Sharing.tasks(f.credentials.reader, "filtered-root", { limit: 16 }))
  expect(first.items).toEqual([])
  expect(first.cursor).toBeDefined()
  await f.restart()
  const next = await f.run(() =>
    Sharing.tasks(f.credentials.reader, "filtered-root", { cursor: first.cursor, limit: 16 }),
  )
  expect(next.watermark).toBe(first.watermark)
  expect(next.items.map((item) => item.sessionID)).toEqual(["child-130", "child-131"])
  expect(next.cursor).toBeUndefined()
  await f.run(() => Storage.remove(Keys.projectMember("project", "reader")))
  await expect(
    f.run(() => Sharing.tasks(f.credentials.reader, "filtered-root", { cursor: first.cursor })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
}, 15_000)
