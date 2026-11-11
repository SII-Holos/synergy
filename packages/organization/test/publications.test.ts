import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { OrganizationPublications, publicationMigration } from "../src/publications"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { directoryFixture } from "./support/session-directory"
import { fixture } from "./support/organization"
import {
  OrganizationPublicationProtocol as Publication,
  OrganizationKnowledgeProtocol as Knowledge,
} from "@ericsanchezok/synergy-organization-protocol"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

test("publication uploads reject unsafe paths, metadata collisions and corrupt bytes", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const upload = await OrganizationPublications.create(f.credentials.alice, {
      requestID: "upload",
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
    })
    for (const path of [
      "../outside",
      "/outside",
      "C:/outside",
      "a\\b",
      "a/./b",
      "CON.txt",
      "a/LPT1",
      "folder./x",
      "folder /x",
      "bad?name",
      "x/" + "a".repeat(256),
    ])
      await expect(
        OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
          path,
          bytes: 3,
          sha256: hash("abc"),
          mediaType: "text/plain",
        }),
      ).rejects.toThrow()
    const file = await OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
      path: "readme.md",
      bytes: 3,
      sha256: hash("abc"),
      mediaType: "text/plain",
    })
    await expect(
      OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
        path: "README.md",
        bytes: 3,
        sha256: hash("abc"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    for (const path of ["readme.md/child", "README.MD/child"])
      await expect(
        OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
          path,
          bytes: 0,
          sha256: hash(""),
          mediaType: "text/plain",
        }),
      ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    await OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
      path: "directory/child",
      bytes: 0,
      sha256: hash(""),
      mediaType: "text/plain",
    })
    await expect(
      OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
        path: "DIRECTORY",
        bytes: 0,
        sha256: hash(""),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    await OrganizationPublications.putChunk(
      f.credentials.alice,
      upload.uploadID,
      file.fileID,
      0,
      new TextEncoder().encode("bad"),
    )
    await expect(
      OrganizationPublications.seal(f.credentials.alice, upload.uploadID, { fileCount: 2, totalBytes: 3 }),
    ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
    await expect(OrganizationPublications.status(f.credentials.bob, upload.uploadID)).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
  })
})

test("upload request retries keep their identity and sealed files cannot change", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const input = {
      requestID: "same",
      purpose: "knowledge" as const,
      scope: { kind: "project" as const, projectID: "project" },
    }
    const upload = await OrganizationPublications.create(f.credentials.alice, input)
    expect(await OrganizationPublications.create(f.credentials.alice, input)).toEqual(upload)
    const file = await OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
      path: "material.txt",
      bytes: 3,
      sha256: hash("abc"),
      mediaType: "text/plain",
    })
    const bytes = new TextEncoder().encode("abc")
    await OrganizationPublications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)
    await OrganizationPublications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)
    const sealed = await OrganizationPublications.seal(f.credentials.alice, upload.uploadID, {
      fileCount: 1,
      totalBytes: 3,
    })
    expect(sealed.state).toBe("sealed")
    await expect(
      OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
        path: "new.txt",
        bytes: 3,
        sha256: hash("abc"),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect((await OrganizationPublications.files(f.credentials.alice, upload.uploadID, { limit: 1 })).items).toEqual([
      file,
    ])
  })
})

test("mounted HTTP publication routes admit binary chunks larger than the JSON body limit", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const body = "a".repeat(150_000)
  const bytes = JSON.stringify(body)
  const uploadResponse = await owner.request("POST", "/publications/uploads", {
    requestID: "large-http",
    purpose: "knowledge",
    scope: { kind: "organization" },
  })
  expect(uploadResponse.status).toBe(200)
  const upload = Publication.Upload.parse(await uploadResponse.json())
  const declared = await owner.request("PUT", `/publications/uploads/${upload.uploadID}/files`, {
    path: "material.txt",
    bytes: bytes.length,
    sha256: hash(bytes),
    mediaType: "text/plain",
  })
  expect(declared.status).toBe(200)
  const file = Publication.File.parse(await declared.json())
  const chunk = await owner.request(
    "PUT",
    `/publications/uploads/${upload.uploadID}/files/${file.fileID}/chunks?offset=0`,
    body,
    { "content-type": "application/octet-stream" },
  )
  expect(chunk.status).toBe(200)
  expect(
    (
      await owner.request("POST", `/publications/uploads/${upload.uploadID}/seal`, {
        fileCount: 1,
        totalBytes: bytes.length,
      })
    ).status,
  ).toBe(200)
  const published = await owner.request("POST", "/knowledge", {
    requestID: "publish-http",
    itemID: "http-material",
    expectedRevision: 0,
    uploadID: upload.uploadID,
    title: "HTTP material",
    kind: "material",
  })
  expect(published.status).toBe(200)
  const release = Knowledge.Release.parse(await published.json())
  const downloaded = await owner.request(
    "GET",
    `/knowledge/${release.itemID}/versions/${release.version}/files/${file.fileID}/content`,
    undefined,
    { range: "bytes=99999-100009" },
  )
  expect(downloaded.status).toBe(206)
  expect(await downloaded.text()).toBe(bytes.slice(99999, 100010))
})

test("publication directory migration covers fresh and pre-index uploads without changing immutable files", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    await publicationMigration.up(() => {})
    const upload = await OrganizationPublications.create(f.credentials.alice, {
      requestID: "old-upload",
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
    })
    const file = await OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
      path: "directory/child",
      bytes: 0,
      sha256: hash(""),
      mediaType: "text/plain",
    })
    await Storage.remove(["organization-publications", "directories", upload.uploadID, hash("directory")])
    await publicationMigration.up(() => {})
    await expect(
      OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
        path: "DIRECTORY",
        bytes: 0,
        sha256: hash(""),
        mediaType: "text/plain",
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect((await OrganizationPublications.files(f.credentials.alice, upload.uploadID, { limit: 10 })).items).toEqual([
      file,
    ])
  })
})
