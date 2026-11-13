import { expect, test } from "bun:test"
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
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
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
  release: Knowledge.Release
  file: Publication.File
  bytes: Uint8Array<ArrayBuffer>
}
type Original = { projectID: string; manifestID: string; published: Published[]; selection: Knowledge.SelectionSummary }
async function publish(
  http: Awaited<ReturnType<typeof client>>,
  kind: "material" | "skill",
  value: Uint8Array,
): Promise<Published> {
  const bytes = Uint8Array.from(value)
  const uploadResponse = await http.request(
    "POST",
    "/publications/uploads",
    JSON.stringify({
      requestID: "fixed-" + kind,
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
  const response = await http.request(
    "POST",
    "/knowledge",
    JSON.stringify({
      requestID: "publish-" + kind,
      itemID: "fixed-" + kind,
      expectedRevision: 0,
      uploadID: upload.uploadID,
      title: "Fixed " + kind,
      kind,
    }),
  )
  expect(response.status).toBe(200)
  return { uploadID: upload.uploadID, release: Knowledge.Release.parse(await response.json()), file, bytes }
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

test("a new H1 immutable release using old sealed bytes still blocks before Source4", async () => {
  await using fixture = await knowledgeFixture()
  const { f } = fixture
  const material = fixture.original.published[0]
  if (!material) throw new Error("Original material is absent")
  await f.source.restart()
  const http = await client(f.source.service, "https://organization.example", "H1 retry password")
  const published = await http.request(
    "POST",
    "/knowledge",
    JSON.stringify({
      requestID: "new-after-h0",
      itemID: "new-after-h0",
      expectedRevision: 0,
      uploadID: material.uploadID,
      title: "New H1 content using old bytes",
      kind: "material",
    }),
  )
  expect(published.status).toBe(200)
  expect(Knowledge.Release.parse(await published.json()).version).toBe(1)
  await f.source.service.close()
  await rejected(f, /H0 facts|incomplete H1/)
}, 30_000)
