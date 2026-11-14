import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { OrganizationSharedProjection as Projection } from "../src/shared-projection"
import { OrganizationSharedTasks as Tasks } from "../src/shared-tasks"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { OrganizationServiceMaintenance as Admission } from "../src/service-maintenance"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
import { fixture } from "./support/organization"
import { sharedProducerFixture } from "./support/shared-producer"
import { OrganizationRetention as Retention } from "../src/retention"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { OrganizationPublications as Publications } from "../src/publications"
import { OrganizationArtifacts as Artifacts } from "../src/artifacts"

const operator = {
  kind: "local" as const,
  subjectID: "retention-operator",
  displayName: "Operator",
  clientKind: "cli" as const,
  requestID: "retire-shared-generation",
}
const target = { sessionID: "retention-session", shareGeneration: 1, requestID: "retire-shared-generation" }

async function seed(service: Awaited<ReturnType<typeof fixture>>["service"]) {
  return service.maintenance.run(() =>
    Admission.run(async () => {
      const deployment = await service.deployment()
      await Storage.write(
        Keys.session(target.sessionID),
        Record.SessionDirectory.parse({
          schemaVersion: 2,
          sessionID: target.sessionID,
          orgID: deployment.orgID,
          projectID: "project",
          creatorID: "creator",
          driverRuntimeID: "member",
          bindingEpoch: 1,
          nextBindingEpoch: 2,
          shareState: "private",
          shareGeneration: 2,
          rowRevision: 2,
          controlRevision: 0,
          retainedExecutionGrants: 0,
          resourceIDs: [],
          createdAt: Date.now(),
        }),
      )
      await Storage.write(Keys.sharedState(target.sessionID), {
        schemaVersion: 1,
        sessionID: target.sessionID,
        shareGeneration: 2,
        bindingEpoch: 1,
        nextSeq: 0,
        syncState: "blocked",
        updatedAt: Date.now(),
      })
      const bytes = new TextEncoder().encode("retired shared copy")
      const hash = createHash("sha256").update(bytes).digest("hex")
      const key = Keys.sharedBlobChunk(target.sessionID, 1, hash, 0)
      await Storage.writeBinary(key, bytes)
      await Storage.write(Keys.sharedBlob(target.sessionID, 1, hash), {
        schemaVersion: 2,
        sessionID: target.sessionID,
        shareGeneration: 1,
        hash,
        bytes: bytes.length,
        chunkBytes: 4 * 1024 * 1024,
        receivedBytes: bytes.length,
        receivedChunks: 1,
        nextOffset: bytes.length,
        complete: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      return key
    }),
  )
}

test("the Host retention operator delays and retires only a superseded sharing copy", async () => {
  await using f = await fixture()
  const key = await seed(f.service)
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const marked = await f.service.maintenance.retention.mark({ ...target, actor: operator, delayMs: 1_000 })
    expect(marked).toMatchObject({ state: "marked" })
    await expect(
      f.service.maintenance.retention.mark({
        ...target,
        sessionID: "another-session",
        actor: operator,
        delayMs: 1_000,
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect((await f.service.maintenance.retention.collect(target)).state).toBe("waiting")
    expect(await f.service.maintenance.run(() => Storage.readBinary(key))).toEqual(
      new TextEncoder().encode("retired shared copy"),
    )
    await f.restart()
    now += 1_000
    expect((await f.service.maintenance.retention.collect(target)).state).toBe("collected")
    await expect(f.service.maintenance.run(() => Storage.readBinary(key))).rejects.toThrow()
    expect((await f.service.maintenance.retention.collect(target)).state).toBe("collected")
    expect(await f.service.maintenance.run(() => Storage.read(Keys.session(target.sessionID)))).toMatchObject({
      shareGeneration: 2,
      shareState: "private",
    })
    await expect(
      f.service.maintenance.run(() =>
        Admission.run(() =>
          Storage.transaction((tx) => tx.insertHistorical(key.slice(0, -2), { revived: true }, Date.now())),
        ),
      ),
    ).rejects.toThrow("revision")
  } finally {
    clock.mockRestore()
  }
})

test("retirement preserves an independent publication and an open native artifact checkpoint", async () => {
  await using f = await sharedProducerFixture(true)
  await f.run(() => {
    RuntimeMaintenance.registerProtection()
    Admission.register()
  })
  const run = <T>(body: () => Promise<T>) => f.run(() => Admission.run(body))
  const bytes = new TextEncoder().encode("the original bytes remain published")
  const hash = createHash("sha256").update(bytes).digest("hex")
  await run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: target.sessionID,
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await run(() => Sharing.share(f.credentials.alice, target.sessionID, { expectedShareGeneration: 0 }))
  await run(() =>
    Sharing.uploadBlob(f.credentials.alice, target.sessionID, {
      shareGeneration: 1,
      hash,
      offset: 0,
      totalBytes: bytes.length,
      bytes,
    }),
  )
  const projection = await run(() => Directory.get(f.credentials.alice, target.sessionID))
  const events = [
    Sync.Event.parse({
      type: "session",
      sequence: 1,
      session: {
        sessionID: target.sessionID,
        projectID: "project",
        creatorID: "alice",
        driverRuntimeID: "runtime-alice",
        bindingEpoch: 1,
        shareGeneration: 1,
        createdAt: projection.createdAt,
      },
    }),
    Sync.Event.parse({
      type: "message",
      sequence: 2,
      messageID: "retired-message",
      role: "user",
      createdAt: projection.createdAt,
      summary: "Retired transcript",
      integrity: hash,
    }),
  ]
  await run(() =>
    f.sync(
      Sync.Batch.parse({
        schemaVersion: 1,
        sessionID: target.sessionID,
        projectID: "project",
        bindingEpoch: 1,
        shareGeneration: 1,
        firstSeq: 1,
        lastSeq: 2,
        events,
        payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 2, events })),
      }),
    ),
  )
  expect((await run(() => Sharing.messages(f.credentials.alice, target.sessionID, { limit: 5 }))).items).toHaveLength(1)
  await run(() => Sharing.tasks(f.credentials.alice, target.sessionID, { limit: 5 }))
  const roots = [
    Keys.sharedEvents(target.sessionID, 1),
    Keys.sharedSessions(target.sessionID, 1),
    Projection.generationPrefix(target.sessionID, 1),
    Tasks.generationPrefix(target.sessionID, 1),
  ]
  for (const prefix of roots) expect((await f.run(() => Storage.queryKeys({ prefix, limit: 1 }))).length).toBe(1)
  const published = await run(async () => {
    const upload = await Publications.create(f.credentials.alice, {
      requestID: "independent-upload",
      purpose: "artifact",
      scope: { kind: "project", projectID: "project" },
      sourceSessionID: target.sessionID,
    })
    const file = await Publications.putFile(f.credentials.alice, upload.uploadID, {
      path: "result.txt",
      bytes: bytes.length,
      sha256: hash,
      mediaType: "text/plain",
    })
    await Publications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)
    await Publications.seal(f.credentials.alice, upload.uploadID, { fileCount: 1, totalBytes: bytes.length })
    await Artifacts.publish(f.credentials.alice, {
      requestID: "publish-independent",
      artifactID: "independent",
      expectedRevision: 0,
      uploadID: upload.uploadID,
      title: "Independent publication",
    })
    return file
  })
  await run(() => Sharing.unshare(f.credentials.alice, target.sessionID, { expectedShareGeneration: 1 }))
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    expect((await f.run(() => Retention.mark({ ...target, actor: operator, delayMs: 1_000 }))).state).toBe("marked")
    await run(() => Sharing.share(f.credentials.alice, target.sessionID, { expectedShareGeneration: 2 }))
    const current = new Uint8Array(4 * 1024 * 1024).fill(17)
    const pendingHash = createHash("sha256")
      .update(current)
      .update(new Uint8Array([18]))
      .digest("hex")
    expect(
      (
        await run(() =>
          Sharing.uploadBlob(f.credentials.alice, target.sessionID, {
            shareGeneration: 3,
            hash: pendingHash,
            offset: 0,
            totalBytes: current.length + 1,
            bytes: current,
          }),
        )
      ).complete,
    ).toBe(false)
    const binaryKey = Keys.sharedBlobChunk(target.sessionID, 1, hash, 0)
    const [retained] = await f.run(() => Storage.artifactReferences({ prefix: binaryKey, limit: 1 }))
    now += 1_000
    await f.run(() =>
      Storage.withArtifactCheckpoint(async (checkpoint) => {
        const result = await Retention.collect(target)
        expect(result.state).toBe("collected")
        const chunks: Uint8Array[] = []
        for await (const chunk of checkpoint.stream(retained!.location)) chunks.push(chunk)
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes))
      }),
    )
    await expect(f.run(() => Storage.readBinary(binaryKey))).rejects.toThrow()
    for (const prefix of roots) expect(await f.run(() => Storage.queryKeys({ prefix, limit: 1 }))).toEqual([])
    expect(await f.run(() => Storage.read(Keys.sharedBatch(target.sessionID, 1, 1)))).toMatchObject({
      firstSeq: 1,
      lastSeq: 2,
    })
    const response = await run(() => Artifacts.content(f.credentials.reader, "independent", 1, published.fileID))
    expect(await response.text()).toBe(new TextDecoder().decode(bytes))
    expect(await f.run(() => Storage.readBinary(Keys.sharedBlobChunk(target.sessionID, 3, pendingHash, 0)))).toEqual(
      current,
    )
    expect(
      (
        await run(() =>
          Sharing.getBlobStatus(f.credentials.bob, target.sessionID, {
            shareGeneration: 3,
            hash: pendingHash,
          }),
        )
      ).complete,
    ).toBe(false)
    await expect(
      run(() =>
        Sharing.uploadBlob(f.credentials.alice, target.sessionID, {
          shareGeneration: 1,
          hash,
          offset: 0,
          totalBytes: bytes.length,
          bytes,
        }),
      ),
    ).rejects.toMatchObject({ data: { code: "SHARE_REVOKED" } })
  } finally {
    clock.mockRestore()
  }
})

test("a marked copy is retained when current ownership is unresolved or a handoff is active", async () => {
  await using f = await fixture()
  const binaryKey = await seed(f.service)
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const update = (body: (session: Record.SessionDirectory) => void) =>
    f.service.maintenance.run(() =>
      Admission.run(() => Storage.update<Record.SessionDirectory>(Keys.session(target.sessionID), body)),
    )
  try {
    await f.service.maintenance.retention.mark({ ...target, actor: operator, delayMs: 1_000 })
    now += 1_000
    await update((session) => {
      session.handoffID = "unresolved-handoff"
    })
    expect(await f.service.maintenance.retention.collect(target)).toEqual({ state: "blocked", reason: "handoff" })
    await update((session) => {
      delete session.handoffID
    })
    const manifestKey = binaryKey.slice(0, -2)
    await f.service.maintenance.run(() =>
      Admission.run(() =>
        Storage.update<Record.SharedBlob>(manifestKey, (blob) => {
          blob.complete = false
        }),
      ),
    )
    expect(await f.service.maintenance.retention.collect(target)).toEqual({
      state: "blocked",
      reason: "incomplete_blob",
    })
    expect(await f.service.maintenance.run(() => Storage.readBinary(binaryKey))).toEqual(
      new TextEncoder().encode("retired shared copy"),
    )
    await update((session) => {
      session.shareGeneration = 1
    })
    expect(await f.service.maintenance.retention.collect(target)).toEqual({
      state: "blocked",
      reason: "current_generation",
    })
  } finally {
    clock.mockRestore()
  }
})

test("backup drains already accepted collection while rejecting newly admitted collection", async () => {
  await using f = await fixture()
  await seed(f.service)
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const read = Record.read
  let held = false
  let capture = false
  const observation = spyOn(Record, "read").mockImplementation(async (schema, key) => {
    const result = await read(schema, key)
    if (capture && !held && key[0] === "organization-retention") {
      held = true
      entered.resolve()
      await proceed.promise
    }
    return result
  })
  let lease: RuntimeMaintenance.Lease | undefined
  let collecting: Promise<unknown> | undefined
  let drainage: Promise<RuntimeMaintenance.DrainReceipt> | undefined
  try {
    await f.service.maintenance.retention.mark({ ...target, actor: operator, delayMs: 1_000 })
    now += 1_000
    capture = true
    const pendingCollection = f.service.maintenance.retention.collect(target)
    collecting = pendingCollection
    await entered.promise
    lease = await f.service.maintenance.run(() =>
      RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "backup-retention",
        actor: { ...operator, requestID: "backup-retention" },
      }),
    )
    await expect(f.service.maintenance.retention.collect(target)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    let drained = false
    drainage = f.service.maintenance.run(async () => {
      const result = await RuntimeMaintenance.drain(lease!)
      drained = true
      return result
    })
    expect(drained).toBe(false)
    proceed.resolve()
    expect((await pendingCollection).state).toBe("collected")
    const receipt = await drainage
    await f.service.maintenance.run(() => RuntimeMaintenance.freeze(lease!, receipt))
    expect((await f.service.maintenance.retention.status(target)).state).toBe("collected")
    expect(drained).toBe(true)
  } finally {
    proceed.resolve()
    observation.mockRestore()
    await Promise.allSettled([collecting, drainage])
    if (lease) await f.service.maintenance.run(() => RuntimeMaintenance.release(lease!))
    clock.mockRestore()
  }
})
