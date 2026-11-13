import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import { openOrganizationService, openOrganizationRecovery } from "../src/service"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationRecoveryAdministration as Recovery } from "../src/backup/administration-recovery"
import { OrganizationBackupAdministration as Administration } from "../src/backup/administration"
import { OrganizationRecoveryWriters as Writers } from "../src/backup/writers"
import { currentPolicyKey, OrganizationCurrentPolicyReceipt } from "../src/backup/policy-records"
import { preparedFixture } from "./support/recovery-administration"
import { password } from "./support/organization"

type Service = Awaited<ReturnType<typeof openOrganizationService>>
async function client(service: Service, origin: string, secret: string) {
  const login = await service.fetch(
    new Request(origin + "/org/v1/auth/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ loginName: "owner", password: secret }),
    }),
  )
  expect(login.status).toBe(200)
  const credentials = Identity.LoginResult.parse(await login.json())
  const cookie = login.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("Actual owner login did not return its private cookie")
  return {
    request(method: string, route: string, body?: BodyInit, mediaType = "application/json") {
      return service.fetch(
        new Request(origin + "/org/v1" + route, {
          method,
          headers: { origin, cookie, "x-csrf-token": credentials.csrfToken, "content-type": mediaType },
          body,
        }),
      )
    },
  }
}

type Published = {
  uploadID: string
  publication: Knowledge.Publish
  release: Knowledge.Release
  file: Publication.File
  bytes: Uint8Array<ArrayBuffer>
}
type Original = { projectID: string; manifestID: string; published: Published[]; selection: Knowledge.SelectionSummary }
async function publish(
  http: Awaited<ReturnType<typeof client>>,
  kind: "material" | "skill",
  value: Uint8Array,
  identity: string = kind,
): Promise<Published> {
  const bytes = Uint8Array.from(value)
  const uploadResponse = await http.request(
    "POST",
    "/publications/uploads",
    JSON.stringify({
      requestID: "fixed-" + identity,
      purpose: "knowledge",
      scope: { kind: "organization" },
    }),
  )
  expect(uploadResponse.status).toBe(200)
  const upload = Publication.Upload.parse(await uploadResponse.json())
  const fileResponse = await http.request(
    "PUT",
    `/publications/uploads/${upload.uploadID}/files`,
    JSON.stringify({
      path: kind === "skill" ? "SKILL.md" : "materials/reference.bin",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: kind === "skill" ? "text/markdown" : "application/octet-stream",
    }),
  )
  expect(fileResponse.status).toBe(200)
  const file = Publication.File.parse(await fileResponse.json())
  for (let offset = 0; offset < bytes.length; offset += Publication.chunkBytes) {
    const chunk = await http.request(
      "PUT",
      `/publications/uploads/${upload.uploadID}/files/${file.fileID}/chunks?offset=${offset}`,
      bytes.subarray(offset, offset + Publication.chunkBytes),
      "application/octet-stream",
    )
    expect(chunk.status).toBe(200)
  }
  expect(
    (
      await http.request(
        "POST",
        `/publications/uploads/${upload.uploadID}/seal`,
        JSON.stringify({
          fileCount: 1,
          totalBytes: bytes.length,
        }),
      )
    ).status,
  ).toBe(200)
  const publication = Knowledge.Publish.parse({
    requestID: "publish-" + identity,
    itemID: "fixed-" + identity,
    expectedRevision: 0,
    uploadID: upload.uploadID,
    title: "Fixed " + identity,
    kind,
  })
  const response = await http.request("POST", "/knowledge", JSON.stringify(publication))
  expect(response.status).toBe(200)
  return {
    uploadID: upload.uploadID,
    publication,
    release: Knowledge.Release.parse(await response.json()),
    file,
    bytes,
  }
}

async function knowledgeFixture(change?: (service: Service, original: Original) => Promise<void>) {
  let original: Original | undefined
  const f = await preparedFixture({
    async beforeH0(source) {
      const http = await client(source.service, "https://organization.example", password)
      const projectResponse = await http.request("POST", "/projects", JSON.stringify({ name: "Knowledge recovery" }))
      expect(projectResponse.status).toBe(200)
      const project = Identity.ProjectView.parse(await projectResponse.json())
      const material = await publish(
        http,
        "material",
        Buffer.from([0, 255, 37, 10, 73, 109, 109, 117, 116, 97, 98, 108, 101]),
      )
      const skill = await publish(
        http,
        "skill",
        Buffer.from("---\nname: fixed-team\ndescription: Original team guidance\n---\nUse the original material.\n"),
      )
      for (const { release, file, bytes } of [material, skill]) {
        const source = await http.request(
          "GET",
          `/knowledge/${release.itemID}/versions/${release.version}/files/${file.fileID}/content`,
        )
        expect(source.status).toBe(200)
        expect(new Uint8Array(await source.arrayBuffer())).toEqual(bytes)
      }
      const updateResponse = await http.request(
        "POST",
        "/knowledge/selection-updates",
        JSON.stringify({
          requestID: "original-selection",
          target: { kind: "member", projectID: project.projectID },
          expectedRevision: 0,
        }),
      )
      expect(updateResponse.status).toBe(200)
      const update = Knowledge.SelectionUpdate.parse(await updateResponse.json())
      expect(
        (
          await http.request(
            "POST",
            `/knowledge/selection-updates/${update.updateID}/pages`,
            JSON.stringify({
              sequence: 0,
              changes: [material, skill].map(({ release }) => ({
                itemID: release.itemID,
                reference: {
                  itemID: release.itemID,
                  version: release.version,
                  manifestHash: release.manifestHash,
                },
              })),
            }),
          )
        ).status,
      ).toBe(200)
      const selected = await http.request(
        "POST",
        `/knowledge/selection-updates/${update.updateID}/commit`,
        JSON.stringify({ expectedSequence: 1 }),
      )
      expect(selected.status).toBe(200)
      original = {
        projectID: project.projectID,
        manifestID: update.updateID,
        published: [material, skill],
        selection: Knowledge.SelectionSummary.parse(await selected.json()),
      }
      expect(original.selection.releaseCount).toBe(2)
      await change?.(source.service, original)
    },
  })
  if (!original) throw new Error("The actual original published selection was not created")
  return {
    f,
    original,
    async [Symbol.asyncDispose]() {
      await f[Symbol.asyncDispose]()
    },
  }
}

test("public recover preserves sealed H0 material, Skill and the original nonempty selection through cold startup", async () => {
  await using fixture = await knowledgeFixture()
  const { f, original: retained } = fixture
  const recovered = await f.invoke()
  expect(recovered.code, recovered.stderr).toBe(0)
  expect(JSON.parse(recovered.stdout)).toMatchObject({ state: "ready", executionEnabled: false })
  for (let reopen = 0; reopen < 2; reopen++) {
    await using target = await openOrganizationService({ home: f.input.home })
    const http = await client(target, f.input.publicOrigin, "H1 retry password")
    const pageResponse = await http.request(
      "GET",
      `/projects/${retained.projectID}/knowledge/applied/releases?limit=100`,
    )
    expect(pageResponse.status).toBe(200)
    const page = Knowledge.SelectionPage.parse(await pageResponse.json())
    expect(page.selection).toEqual(retained.selection)
    expect(page.items).toEqual(
      retained.published
        .map(({ release }) => ({
          itemID: release.itemID,
          version: release.version,
          manifestHash: release.manifestHash,
        }))
        .sort((a, b) => a.itemID.localeCompare(b.itemID)),
    )
    for (const { release, file, bytes } of retained.published) {
      const response = await http.request(
        "GET",
        `/knowledge/${release.itemID}/versions/${release.version}/files/${file.fileID}/content`,
      )
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    }
  }
  expect(await f.materialHash()).toBe(f.originalKey)
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    4,
  )
}, 30_000)

async function rejected(f: Awaited<ReturnType<typeof preparedFixture>>, reason: RegExp) {
  const result = await f.invoke()
  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(reason)
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    2,
  )
  await f.source.restart()
  const status = await f.source.service.maintenance.run(() => RuntimeMaintenance.status())
  expect(status?.phase).toBe("released")
  if (!status) throw new Error("Original recovery maintenance receipt was lost")
  expect(
    await f.source.service.maintenance.run(() => RuntimeMaintenance.retirement(status.maintenanceID)),
  ).toBeUndefined()
  expect(await f.materialHash()).toBe(f.originalKey)
  await using target = await openOrganizationRecovery({ home: f.input.home })
  expect((await target.run(() => RuntimeMaintenance.status()))?.phase).toBe("recovery-held")
}

for (const corruption of ["missing-reference", "wrong-inverse-index"] as const) {
  test(`historical knowledge ${corruption} blocks recovery before irreversible Source effects`, async () => {
    await using fixture = await knowledgeFixture(async (service, original) => {
      const material = original.published[0]
      if (!material) throw new Error("Original material is absent")
      const root = ["organization-knowledge", "manifests", material.release.orgID, original.manifestID]
      await service.maintenance.run(async () => {
        if (corruption === "missing-reference") await Storage.remove([...root, "references", "0000000000000000"])
        else await Storage.write([...root, "items", material.release.itemID], 1)
      })
    })
    await rejected(
      fixture.f,
      corruption === "missing-reference" ? /manifest order is incomplete/ : /inverse index changed/,
    )
  }, 30_000)
}

test("actual retained publication bytes are checked before service Source retirement", async () => {
  await using fixture = await knowledgeFixture()
  const material = fixture.original.published[0]
  if (!material) throw new Error("Original material is absent")
  const { f } = fixture
  await using target = await openOrganizationRecovery({ home: f.input.home })
  await target.run(async () => {
    const row = (
      await Storage.artifactReferences({
        prefix: ["organization-publications", "bytes", material.uploadID, material.file.fileID],
        limit: 1,
      })
    )[0]
    if (!row) throw new Error("Original publication chunk was not installed")
    const file = await fs.open(
      path.join(Storage.current().artifactDirectory, "agent-artifacts", row.location.pack),
      "r+",
    )
    try {
      const byte = Buffer.alloc(1)
      await file.read(byte, 0, 1, row.location.blockOffset)
      byte.writeUInt8(byte.readUInt8(0) ^ 255, 0)
      await file.write(byte, 0, 1, row.location.blockOffset)
      await file.sync()
    } finally {
      await file.close()
    }
  })
  await target.close()
  await rejected(f, /checksum|artifact/i)
}, 30_000)

test("rehashed publication metadata cannot replace verification of the complete file SHA", async () => {
  await using fixture = await knowledgeFixture(async (service, original) => {
    const material = original.published[0]
    if (!material) throw new Error("Original material is absent")
    const file = { ...material.file, sha256: "1".repeat(64) }
    const manifestHash = createHash("sha256").update(Publication.manifestLine(file)).digest("hex")
    await service.maintenance.run(async () => {
      for (const [key, replacement] of [
        [["organization-publications", "files", material.uploadID, file.fileID], { sha256: file.sha256 }],
        [["organization-publications", "uploads", material.uploadID], { manifestHash }],
        [
          ["organization-knowledge", "releases", material.release.orgID, material.release.itemID, "0000000000000001"],
          { manifestHash },
        ],
      ] satisfies Array<[string[], Record<string, string>]>) {
        const before = z.record(z.string(), z.unknown()).parse(await Storage.read(key))
        await Storage.write(key, { ...before, ...replacement })
      }
    })
  })
  await rejected(fixture.f, /file checksum does not match/)
}, 30_000)

async function newH1ReleaseFixture(bytes: "retained" | "fresh" = "retained") {
  const fixture = await knowledgeFixture()
  try {
    const { f } = fixture
    const material = fixture.original.published[0]
    if (!material) throw new Error("Original material is absent")
    await f.source.restart()
    const http = await client(f.source.service, "https://organization.example", "H1 retry password")
    if (bytes === "fresh") {
      const material = await publish(
        http,
        "material",
        Uint8Array.from({ length: Publication.chunkBytes + 37 }, (_, index) => (index * 73 + 19) % 256),
        "h1-content",
      )
      await f.source.service.close()
      return { ...fixture, material, publication: material.publication, release: material.release }
    }
    const publication = Knowledge.Publish.parse({
      requestID: "new-after-h0",
      itemID: "new-after-h0",
      expectedRevision: 0,
      uploadID: material.uploadID,
      title: "New H1 content using old bytes",
      kind: "material",
    })
    const published = await http.request("POST", "/knowledge", JSON.stringify(publication))
    expect(published.status).toBe(200)
    const release = Knowledge.Release.parse(await published.json())
    expect(release.version).toBe(1)
    await f.source.service.close()
    return { ...fixture, material, publication, release }
  } catch (error) {
    await fixture[Symbol.asyncDispose]()
    throw error
  }
}

test("public recover adopts a new H1 immutable release using the original H0 sealed bytes", async () => {
  await using fixture = await newH1ReleaseFixture()
  const { f, material, publication, release } = fixture
  const recovered = await f.invoke()
  expect(recovered.code, recovered.stderr).toBe(0)
  expect(JSON.parse(recovered.stdout)).toMatchObject({ state: "ready", executionEnabled: false })
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    4,
  )
  for (let reopen = 0; reopen < 2; reopen++) {
    await using target = await openOrganizationService({ home: f.input.home })
    expect(
      (
        await target.fetch(
          new Request(f.input.publicOrigin + "/org/v1/auth/login", {
            method: "POST",
            headers: { origin: f.input.publicOrigin, "content-type": "application/json" },
            body: JSON.stringify({ loginName: "owner", password }),
          }),
        )
      ).status,
    ).toBe(401)
    const restored = await client(target, f.input.publicOrigin, "H1 retry password")
    const version = await restored.request("GET", `/knowledge/${release.itemID}/versions/${release.version}`)
    expect(version.status).toBe(200)
    expect(Knowledge.Release.parse(await version.json())).toEqual(release)
    const receipt = await restored.request("POST", "/knowledge/publication-receipts", JSON.stringify(publication))
    expect(receipt.status).toBe(200)
    expect(Knowledge.PublicationReceipt.parse(await receipt.json())).toEqual({ state: "published", release })
    const content = await restored.request(
      "GET",
      `/knowledge/${release.itemID}/versions/${release.version}/files/${material.file.fileID}/content`,
    )
    expect(content.status).toBe(200)
    const bytes = new Uint8Array(await content.arrayBuffer())
    expect(bytes).toEqual(material.bytes)
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(material.file.sha256)
  }
  expect(await f.materialHash()).toBe(f.originalKey)
}, 30_000)

test("public recover adopts a new H1 sealed upload and immutable release with new physical bytes", async () => {
  await using fixture = await knowledgeFixture()
  const { f, original } = fixture
  await f.source.restart()
  const http = await client(f.source.service, "https://organization.example", "H1 retry password")
  const content = Uint8Array.from({ length: Publication.chunkBytes + 37 }, (_, index) => (index * 73 + 19) % 256)
  const published = await publish(http, "material", content, "h1-content")
  const sourceContent = await http.request(
    "GET",
    `/knowledge/${published.release.itemID}/versions/${published.release.version}/files/${published.file.fileID}/content`,
  )
  expect(sourceContent.status).toBe(200)
  expect(new Uint8Array(await sourceContent.arrayBuffer())).toEqual(content)
  await f.source.service.close()
  {
    await using held = await openOrganizationRecovery({ home: f.input.home })
    await held.run(async () => {
      expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
      expect(
        (await Storage.readMany([["organization-publications", "uploads", published.uploadID]]))[0],
      ).toBeUndefined()
      expect(
        await Storage.artifactReferences({
          prefix: ["organization-publications", "bytes", published.uploadID],
          limit: 3,
        }),
      ).toEqual([])
    })
  }
  const baseNamespaceID = await Administration.withExistingTarget(f.input, (context) =>
    context.withPrepared(async (original) => original.native.manifest.source.namespaceID),
  )
  const recovered = await f.invoke()
  expect(recovered.code, recovered.stderr).toBe(0)
  expect(JSON.parse(recovered.stdout)).toMatchObject({ state: "ready", executionEnabled: false })
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    4,
  )
  expect(await f.materialHash()).toBe(f.originalKey)
  const archived = { directory: path.join(f.input.work, "h1", "records"), keys: f.input.keys }
  const manifest = await StorageCheckpoint.verifyArchive(archived)
  expect(manifest.namespaceID).toBe(baseNamespaceID)
  for (let reopen = 0; reopen < 2; reopen++) {
    await using target = await openOrganizationService({ home: f.input.home })
    if (reopen === 0) {
      const journal = await target.maintenance.run(() =>
        AuthorityJournal.readArchivedCheckpoint({ ...archived, expected: manifest }),
      )
      expect(journal.namespaceID).toBe(published.release.orgID)
      expect(manifest.namespaceID).not.toBe(journal.namespaceID)
    }
    const restored = await client(target, f.input.publicOrigin, "H1 retry password")
    const version = await restored.request(
      "GET",
      `/knowledge/${published.release.itemID}/versions/${published.release.version}`,
    )
    expect(version.status).toBe(200)
    expect(Knowledge.Release.parse(await version.json())).toEqual(published.release)
    const receipt = await restored.request(
      "POST",
      "/knowledge/publication-receipts",
      JSON.stringify(published.publication),
    )
    expect(receipt.status).toBe(200)
    expect(Knowledge.PublicationReceipt.parse(await receipt.json())).toEqual({
      state: "published",
      release: published.release,
    })
    const response = await restored.request(
      "GET",
      `/knowledge/${published.release.itemID}/versions/${published.release.version}/files/${published.file.fileID}/content`,
    )
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes).toEqual(content)
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(published.file.sha256)
    const selection = await restored.request(
      "GET",
      `/projects/${original.projectID}/knowledge/applied/releases?limit=100`,
    )
    expect(selection.status).toBe(200)
    expect(Knowledge.SelectionPage.parse(await selection.json()).selection).toEqual(original.selection)
  }
}, 30_000)

test("knowledge metadata finalization rolls back skipped and caught writes before exact unknown retry", async () => {
  await using fixture = await newH1ReleaseFixture("fresh")
  const { f, release, material, publication } = fixture
  const policyKey = currentPolicyKey(f.target.installationID)
  const releaseKey = [
    "organization-knowledge",
    "releases",
    release.orgID,
    release.itemID,
    String(release.version).padStart(16, "0"),
  ]
  async function held() {
    await using target = await openOrganizationRecovery({ home: f.input.home })
    return await target.run(async () => {
      const [policy, metadata] = await Storage.readMany([policyKey, releaseKey])
      return {
        policy,
        metadata,
        checkpoint: await AuthorityJournal.head(),
        phase: (await RuntimeMaintenance.status())?.phase,
        aliases: await Storage.artifactReferences({
          prefix: ["organization-publications", "bytes", material.uploadID],
          limit: 10,
        }),
      }
    })
  }
  const original = await held()
  const publish = Writers.publishKnowledgeDelta,
    seal = Writers.sealPreflight
  const omitted = { calls: 0, caught: 0 }
  {
    using missing = spyOn(Writers, "publishKnowledgeDelta").mockImplementation(async () => {
      omitted.calls++
    })
    using swallowed = spyOn(Writers, "sealPreflight").mockImplementation(async (tx) => {
      try {
        await seal(tx)
      } catch {
        omitted.caught++
      }
    })
    await expect(Recovery.recover(f.input)).rejects.toThrow()
  }
  expect(omitted).toEqual({ calls: 1, caught: 1 })
  expect(await held()).toEqual(original)
  expect((await Bun.file(path.join(f.input.sourceHome, ".synergy", "home-ownership.json")).json()).schemaVersion).toBe(
    4,
  )
  const write = StoreTransaction.prototype.write
  const failure = new Error("Last immutable release write failed after its actual staged effect")
  const caught = { writes: 0, publisher: 0, seal: 0 }
  {
    using interrupted = spyOn(StoreTransaction.prototype, "write").mockImplementation(async function (
      this: StoreTransaction,
      ...args: Parameters<typeof write>
    ) {
      await write.apply(this, args)
      if (JSON.stringify(args[0]) === JSON.stringify(releaseKey)) {
        caught.writes++
        throw failure
      }
    })
    using swallowed = spyOn(Writers, "publishKnowledgeDelta").mockImplementation(async (tx) => {
      try {
        await publish(tx)
      } catch (error) {
        if (error !== failure) throw error
        expect((await tx.readMany([releaseKey]))[0]).toMatchObject(release)
        caught.publisher++
      }
    })
    using ignored = spyOn(Writers, "sealPreflight").mockImplementation(async (tx) => {
      try {
        await seal(tx)
      } catch {
        caught.seal++
      }
    })
    await expect(Recovery.recover(f.input)).rejects.toThrow()
  }
  expect(caught).toEqual({ writes: 1, publisher: 1, seal: 1 })
  expect(await held()).toEqual(original)
  const transaction = RuntimeMaintenance.restorationTransaction
  const lost = new Error("Committed H1 metadata acknowledgement was lost")
  const observed = { committed: false }
  {
    using unknown = spyOn(RuntimeMaintenance, "restorationTransaction").mockImplementation(
      async <T>(
        input: Parameters<typeof transaction>[0],
        body: (tx: StoreTransaction) => Promise<T>,
        options?: Parameters<typeof transaction>[2],
      ) => {
        const result = await transaction(input, body, options)
        if (!observed.committed && (await Storage.readMany([policyKey]))[0] !== undefined) {
          observed.committed = true
          throw lost
        }
        return result
      },
    )
    await expect(Recovery.recover(f.input)).rejects.toBe(lost)
  }
  expect(observed.committed).toBe(true)
  const retained = await held()
  expect(retained.phase).toBe("recovery-held")
  expect(retained.metadata).toMatchObject(release)
  expect(retained.aliases).toHaveLength(Math.ceil(material.bytes.length / Publication.chunkBytes))
  expect(OrganizationCurrentPolicyReceipt.parse(retained.policy).checkpoint).toEqual(retained.checkpoint)
  const retried = await f.invoke()
  expect(retried.code, retried.stderr).toBe(0)
  expect(JSON.parse(retried.stdout)).toMatchObject({ state: "ready", executionEnabled: false })
  expect(await f.materialHash()).toBe(f.originalKey)
  await using target = await openOrganizationService({ home: f.input.home })
  const http = await client(target, f.input.publicOrigin, "H1 retry password")
  const version = await http.request("GET", `/knowledge/${release.itemID}/versions/${release.version}`)
  expect(version.status).toBe(200)
  expect(Knowledge.Release.parse(await version.json())).toEqual(release)
  const receipt = await http.request("POST", "/knowledge/publication-receipts", JSON.stringify(publication))
  expect(receipt.status).toBe(200)
  expect(Knowledge.PublicationReceipt.parse(await receipt.json())).toEqual({ state: "published", release })
  const content = await http.request(
    "GET",
    `/knowledge/${release.itemID}/versions/${release.version}/files/${material.file.fileID}/content`,
  )
  expect(content.status).toBe(200)
  const restored = new Uint8Array(await content.arrayBuffer())
  expect(restored).toEqual(material.bytes)
  expect(createHash("sha256").update(restored).digest("hex")).toBe(material.file.sha256)
}, 30_000)
