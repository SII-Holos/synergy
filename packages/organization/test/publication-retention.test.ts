import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { fixture } from "./support/organization"
import { directoryFixture } from "./support/session-directory"
import { OrganizationPublications as Publications, publicationLifecycleMigration } from "../src/publications"
import { OrganizationRetention as Retention } from "../src/retention"
import { OrganizationServiceMaintenance as Admission } from "../src/service-maintenance"
import { OrganizationRecord } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationKnowledge as Knowledge } from "../src/knowledge"

const operator = {
  kind: "local" as const,
  subjectID: "publication-retention",
  displayName: "Operator",
  clientKind: "cli" as const,
  requestID: "gc-abandoned-upload",
}

test("an author's explicit abandonment survives cold startup before delayed logical upload collection", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const created = await owner.request("POST", "/publications/uploads", {
    requestID: "abandon-http",
    purpose: "knowledge",
    scope: { kind: "organization" },
  })
  expect(created.status).toBe(200)
  const upload = Publication.Upload.parse(await created.json())
  const body = { content: "Unpublished data" }
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const declared = await owner.request("PUT", `/publications/uploads/${upload.uploadID}/files`, {
    path: "draft.txt",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: "application/json",
  })
  expect(declared.status).toBe(200)
  const file = Publication.File.parse(await declared.json())
  expect(
    (
      await owner.request(
        "PUT",
        `/publications/uploads/${upload.uploadID}/files/${file.fileID}/chunks?offset=0`,
        body,
        { "content-type": "application/octet-stream" },
      )
    ).status,
  ).toBe(200)
  await f.service.maintenance.run(() =>
    Admission.run(async () => {
      await Storage.update<{ schemaVersion: number }>(
        ["organization-publications", "uploads", upload.uploadID],
        (value) => {
          value.schemaVersion = 1
        },
      )
      await Storage.update<Record<string, number>>(["meta", "migration", "log-organization"], (value) => {
        delete value[publicationLifecycleMigration.id]
      })
    }),
  )
  await f.restart()
  expect(
    await f.service.maintenance.run(() => Storage.read(["organization-publications", "uploads", upload.uploadID])),
  ).toMatchObject({ schemaVersion: 2, state: "open" })
  const abandoned = await owner.request("POST", `/publications/uploads/${upload.uploadID}/abandon`, {
    requestID: "abandon-original",
  })
  expect(abandoned.status).toBe(200)
  const receipt: unknown = await abandoned.json()
  expect(receipt).toMatchObject({
    uploadID: upload.uploadID,
    requestID: "abandon-original",
    state: "abandoned",
    from: "open",
  })
  await f.restart()
  const status = await owner.request("GET", `/publications/uploads/${upload.uploadID}`)
  expect(await status.json()).toMatchObject({ state: "abandoned", abandonment: receipt })
  expect(
    await (
      await owner.request("POST", `/publications/uploads/${upload.uploadID}/abandon`, { requestID: "abandon-original" })
    ).json(),
  ).toEqual(receipt)
  expect(
    (
      await owner.request("POST", `/publications/uploads/${upload.uploadID}/seal`, {
        fileCount: 1,
        totalBytes: bytes.length,
      })
    ).status,
  ).toBe(409)
  const target = { uploadID: upload.uploadID, requestID: operator.requestID }
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    expect(
      (await f.service.maintenance.retention.uploads.mark({ ...target, actor: operator, delayMs: 1_000 })).state,
    ).toBe("marked")
    expect((await f.service.maintenance.retention.uploads.collect(target)).state).toBe("waiting")
    const prefix = ["organization-publications", "bytes", upload.uploadID]
    const [original] = await f.service.maintenance.run(() => Storage.artifactReferences({ prefix, limit: 1 }))
    expect(original).toBeDefined()
    now += 1_000
    await f.service.maintenance.run(() =>
      Storage.withArtifactCheckpoint(async (checkpoint) => {
        expect((await f.service.maintenance.retention.uploads.collect(target)).state).toBe("collected")
        const chunks: Uint8Array[] = []
        for await (const chunk of checkpoint.stream(original!.location)) chunks.push(chunk)
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes))
      }),
    )
    expect(await f.service.maintenance.run(() => Storage.artifactReferences({ prefix }))).toEqual([])
    expect((await f.service.maintenance.retention.uploads.collect(target)).state).toBe("collected")
    expect(await (await owner.request("GET", `/publications/uploads/${upload.uploadID}`)).json()).toMatchObject({
      state: "abandoned",
      abandonment: receipt,
      fileCount: 1,
    })
    expect(
      await f.service.maintenance.run(() =>
        Storage.read(["organization-publications", "chunks", upload.uploadID, file.fileID, "0"]),
      ),
    ).toMatchObject({ bytes: bytes.length })
  } finally {
    clock.mockRestore()
  }
})

async function draft(f: Awaited<ReturnType<typeof directoryFixture>>, requestID: string, uploaded = true) {
  return f.run(async () => {
    const upload = await Publications.create(f.credentials.alice, {
      requestID,
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
    })
    const bytes = new TextEncoder().encode("draft")
    const file = await Publications.putFile(f.credentials.alice, upload.uploadID, {
      path: "draft.txt",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: "text/plain",
    })
    if (uploaded) await Publications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)
    return { upload, file, bytes }
  })
}

test("an author can abandon a held sealer without resurrection or publication", async () => {
  await using f = await directoryFixture()
  const { upload, bytes } = await draft(f, "held-sealer")
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const read = Storage.readBinary
  const observation = spyOn(Storage, "readBinary").mockImplementation(async (key, options) => {
    const result = await read(key, options)
    if (key[2] === upload.uploadID) {
      entered.resolve()
      await proceed.promise
    }
    return result
  })
  const sealing = f.run(() =>
    Publications.seal(f.credentials.alice, upload.uploadID, { fileCount: 1, totalBytes: bytes.length }),
  )
  try {
    await entered.promise
    const receipt = await f.run(() =>
      Publications.abandon(f.credentials.alice, upload.uploadID, { requestID: "stop-sealer" }),
    )
    expect(receipt.from).toBe("sealing")
    proceed.resolve()
    await expect(sealing).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect(await f.run(() => Publications.status(f.credentials.alice, upload.uploadID))).toMatchObject({
      state: "abandoned",
      abandonment: receipt,
    })
    await expect(
      f.run(() => Publications.seal(f.credentials.alice, upload.uploadID, { fileCount: 1, totalBytes: bytes.length })),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    await expect(
      f.run(() =>
        Knowledge.publish(f.credentials.alice, {
          requestID: "cannot-publish",
          uploadID: upload.uploadID,
          itemID: "never-published",
          expectedRevision: 0,
          title: "Draft",
          kind: "material",
        }),
      ),
    ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
    await f.restart()
    const client = createOrganizationClient({
      baseUrl: f.baseUrl,
      headers: { ...f.headers("alice"), origin: "https://organization.example", "x-csrf-token": "f".repeat(64) },
    })
    expect(
      (
        await client.orgPublications.abandon(
          { uploadID: upload.uploadID, requestID: "stop-sealer" },
          { throwOnError: true },
        )
      ).data,
    ).toEqual(receipt)
    await expect(
      f.run(() => Publications.abandon(f.credentials.alice, upload.uploadID, { requestID: "changed-stop" })),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  } finally {
    proceed.resolve()
    await Promise.allSettled([sealing])
    observation.mockRestore()
  }
})

test("abandonment rejects nonauthors and rechecks queued current authorization", async () => {
  await using f = await directoryFixture()
  const { upload } = await draft(f, "revoked-author")
  await f.run(() =>
    Storage.write(Keys.projectMember("project", "owner"), {
      schemaVersion: 1,
      accountID: "owner",
      projectID: "project",
      role: "maintainer",
      revision: 1,
    }),
  )
  await expect(
    f.run(() => Publications.abandon(f.credentials.owner, upload.uploadID, { requestID: "not-author" })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const blocker = f.run(() =>
    Storage.transaction(async () => {
      entered.resolve()
      await proceed.promise
    }),
  )
  await entered.promise
  const revocation = f.run(() =>
    Storage.update<OrganizationRecord.Account>(Keys.account("alice"), (value) => {
      value.state = "removed"
      value.authRevision++
    }),
  )
  const pending = f.run(() =>
    Publications.abandon(f.credentials.alice, upload.uploadID, { requestID: "queued-abandon" }),
  )
  try {
    proceed.resolve()
    await revocation
    await expect(pending).rejects.toMatchObject({ data: { code: "AUTHENTICATION_REQUIRED" } })
    expect(await f.run(() => Storage.read(["organization-publications", "uploads", upload.uploadID]))).toMatchObject({
      state: "open",
    })
  } finally {
    proceed.resolve()
    await Promise.allSettled([blocker, revocation, pending])
  }
})

test("a native preparation held across abandonment cannot publish even after logical collection", async () => {
  await using f = await directoryFixture()
  await f.run(() => {
    RuntimeMaintenance.registerProtection()
    Admission.register()
  })
  const { upload, file, bytes } = await f.run(() => Admission.run(() => draft(f, "held-chunk", false)))
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const prepare = Storage.prepareBinary
  let retained: Storage.PreparedBinary | undefined
  const observation = spyOn(Storage, "prepareBinary").mockImplementation(async (key, value) => {
    retained = await prepare(key, value)
    entered.resolve()
    await proceed.promise
    return retained
  })
  const pending = f.run(() =>
    Admission.run(() => Publications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)),
  )
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    await entered.promise
    const receipt = await f.run(() =>
      Admission.run(() =>
        Publications.abandon(f.credentials.alice, upload.uploadID, { requestID: "abandon-prepared" }),
      ),
    )
    await expect(f.run(() => Storage.preparedBinaryReceipt(retained!))).resolves.toBeUndefined()
    const target = { uploadID: upload.uploadID, requestID: "collect-prepared" }
    expect((await f.run(() => Retention.Uploads.mark({ ...target, actor: operator, delayMs: 1 }))).state).toBe("marked")
    now++
    expect((await f.run(() => Retention.Uploads.collect(target))).state).toBe("collected")
    await expect(f.run(() => Storage.preparedBinaryReceipt(retained!))).resolves.toBeUndefined()
    proceed.resolve()
    await expect(pending).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    await expect(f.run(() => Storage.preparedBinaryReceipt(retained!))).rejects.toThrow("not available")
    expect(
      await f.run(() => Storage.artifactReferences({ prefix: Publications.bytesPrefix(upload.uploadID) })),
    ).toEqual([])
    expect(
      await f.run(() =>
        Publications.create(f.credentials.alice, {
          requestID: "held-chunk",
          purpose: "knowledge",
          scope: { kind: "project", projectID: "project" },
        }),
      ),
    ).toMatchObject({ uploadID: upload.uploadID, state: "abandoned", abandonment: receipt })
  } finally {
    proceed.resolve()
    await Promise.allSettled([pending])
    observation.mockRestore()
    clock.mockRestore()
  }
})

test("upload lifecycle migration rolls back malformed pages and preserves already-current native data on retry", async () => {
  await using f = await directoryFixture()
  const { upload, file, bytes } = await draft(f, "legacy-lifecycle")
  const key = ["organization-publications", "uploads", upload.uploadID]
  await f.run(async () => {
    await Storage.update<{ schemaVersion: number }>(key, (value) => {
      value.schemaVersion = 1
    })
    await Storage.write(["organization-publications", "uploads", "zz-invalid"], {
      schemaVersion: 73,
      uploadID: "zz-invalid",
    })
    await expect(publicationLifecycleMigration.up(() => {})).rejects.toThrow()
    expect(await Storage.read(key)).toMatchObject({ schemaVersion: 1 })
    expect(await Publications.readChunk(upload.uploadID, file.fileID, 0)).toEqual(bytes)
    await Storage.remove(["organization-publications", "uploads", "zz-invalid"])
    await publicationLifecycleMigration.up(() => {})
    expect(await Storage.read(key)).toMatchObject({ schemaVersion: 2 })
    const original = await Storage.query({ prefix: key })
    await publicationLifecycleMigration.up(() => {})
    expect(await Storage.query({ prefix: key })).toEqual(original)
    expect(await Publications.readChunk(upload.uploadID, file.fileID, 0)).toEqual(bytes)
  })
})

test("open and sealed uploads retain all bytes, including a published historical knowledge version", async () => {
  await using f = await directoryFixture()
  const current = await draft(f, "keep-open")
  const first = await draft(f, "keep-history")
  const next = await draft(f, "keep-latest")
  await f.run(() => {
    RuntimeMaintenance.registerProtection()
    Admission.register()
  })
  await f.run(() =>
    Admission.run(async () => {
      expect(
        await Retention.Uploads.mark({
          uploadID: current.upload.uploadID,
          requestID: "no-ttl-open",
          actor: operator,
          delayMs: 1,
        }),
      ).toEqual({ state: "blocked", reason: "not_abandoned" })
      for (const [index, value] of [first, next].entries()) {
        await Publications.seal(f.credentials.alice, value.upload.uploadID, {
          fileCount: 1,
          totalBytes: value.bytes.length,
        })
        await Knowledge.publish(f.credentials.alice, {
          requestID: `keep-version-${index}`,
          uploadID: value.upload.uploadID,
          itemID: "retained-material",
          expectedRevision: index,
          title: "Material",
          kind: "material",
        })
      }
      for (const value of [first, next]) {
        await expect(
          Publications.abandon(f.credentials.alice, value.upload.uploadID, { requestID: "never-abandon-sealed" }),
        ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
        expect(
          await Retention.Uploads.mark({
            uploadID: value.upload.uploadID,
            requestID: `no-gc-${value.upload.uploadID}`,
            actor: operator,
            delayMs: 1,
          }),
        ).toEqual({ state: "blocked", reason: "not_abandoned" })
      }
      const response = await Knowledge.content(f.credentials.reader, "retained-material", 1, first.file.fileID)
      expect(await response.text()).toBe(new TextDecoder().decode(first.bytes))
      expect(await Publications.readChunk(current.upload.uploadID, current.file.fileID, 0)).toEqual(current.bytes)
    }),
  )
})

test("collection rechecks original abandonment, deployment and exact owner artifacts", async () => {
  await using f = await directoryFixture()
  const { upload, file, bytes } = await draft(f, "owner-recheck")
  const key = ["organization-publications", "uploads", upload.uploadID]
  const target = { uploadID: upload.uploadID, requestID: "original-upload-mark" }
  await f.run(() => {
    RuntimeMaintenance.registerProtection()
    Admission.register()
  })
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    await f.run(() =>
      Admission.run(async () => {
        await Publications.abandon(f.credentials.alice, upload.uploadID, { requestID: "original-stop" })
        await Retention.Uploads.mark({ ...target, actor: operator, delayMs: 1 })
        now++
        await Storage.update<{ abandonment: Publication.Abandonment }>(key, (value) => {
          value.abandonment.requestID = "altered-stop"
        })
        expect(await Retention.Uploads.collect(target)).toEqual({ state: "blocked", reason: "unknown_state" })
        await Storage.update<{ abandonment: Publication.Abandonment }>(key, (value) => {
          value.abandonment.requestID = "original-stop"
        })
        await Storage.update<{ deploymentIncarnation: string }>(Keys.deployment(), (value) => {
          value.deploymentIncarnation = "new-deployment"
        })
        expect(await Retention.Uploads.collect(target)).toEqual({ state: "blocked", reason: "deployment" })
        await Storage.update<{ deploymentIncarnation: string }>(Keys.deployment(), (value) => {
          value.deploymentIncarnation = "deployment"
        })
        const unknown = [...Publications.bytesPrefix(upload.uploadID), "unknown-owner"]
        await Storage.writeBinary(unknown, bytes)
        expect(await Retention.Uploads.collect(target)).toEqual({ state: "blocked", reason: "unknown_state" })
        expect(await Publications.readChunk(upload.uploadID, file.fileID, 0)).toEqual(bytes)
        await Storage.removeTree(unknown)
        const collected = await Retention.Uploads.collect(target)
        expect(collected).toMatchObject({ state: "collected", candidate: { removedArtifacts: 1 } })
        await expect(Storage.transaction((tx) => tx.insertHistorical(key, { revived: true }, now))).rejects.toThrow(
          "revision",
        )
      }),
    )
  } finally {
    clock.mockRestore()
  }
})

test("backup drains an accepted abandoned-upload collection and rejects a new collector", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const created = await owner.request("POST", "/publications/uploads", {
    requestID: "backup-abandon",
    purpose: "knowledge",
    scope: { kind: "organization" },
  })
  const upload = Publication.Upload.parse(await created.json())
  expect(
    (await owner.request("POST", `/publications/uploads/${upload.uploadID}/abandon`, { requestID: "backup-stop" }))
      .status,
  ).toBe(200)
  const target = { uploadID: upload.uploadID, requestID: "backup-upload-mark" }
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const read = OrganizationRecord.read
  let held = false
  let capture = false
  const observation = spyOn(OrganizationRecord, "read").mockImplementation(async (schema, key) => {
    const value = await read(schema, key)
    if (capture && !held && key[1] === "publication-uploads") {
      held = true
      entered.resolve()
      await proceed.promise
    }
    return value
  })
  let lease: RuntimeMaintenance.Lease | undefined
  let collection: Promise<unknown> | undefined
  let drainage: Promise<RuntimeMaintenance.DrainReceipt> | undefined
  try {
    await f.service.maintenance.retention.uploads.mark({ ...target, actor: operator, delayMs: 1 })
    now++
    capture = true
    const pending = f.service.maintenance.retention.uploads.collect(target)
    collection = pending
    await entered.promise
    lease = await f.service.maintenance.run(() =>
      RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "backup-upload",
        actor: { ...operator, requestID: "backup-upload" },
      }),
    )
    await expect(f.service.maintenance.retention.uploads.collect(target)).rejects.toBeInstanceOf(
      RuntimeMaintenance.Blocked,
    )
    let drained = false
    drainage = f.service.maintenance.run(async () => {
      const receipt = await RuntimeMaintenance.drain(lease!)
      drained = true
      return receipt
    })
    expect(drained).toBe(false)
    proceed.resolve()
    expect((await pending).state).toBe("collected")
    const receipt = await drainage
    await f.service.maintenance.run(() => RuntimeMaintenance.freeze(lease!, receipt))
    expect((await f.service.maintenance.retention.uploads.status(target)).state).toBe("collected")
    expect(drained).toBe(true)
  } finally {
    proceed.resolve()
    observation.mockRestore()
    await Promise.allSettled([collection, drainage])
    if (lease) await f.service.maintenance.run(() => RuntimeMaintenance.release(lease!))
    clock.mockRestore()
  }
})
