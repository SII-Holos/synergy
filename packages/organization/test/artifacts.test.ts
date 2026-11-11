import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationArtifacts } from "../src/artifacts"
import { OrganizationPublications } from "../src/publications"
import { OrganizationSessionDirectory } from "../src/session-directory"
import { OrganizationStoragePath } from "../src/storage/path"
import { directoryFixture } from "./support/session-directory"

async function upload(f: Awaited<ReturnType<typeof directoryFixture>>, text: string, sessionID = "source") {
  return f.run(async () => {
    const bytes = new TextEncoder().encode(text)
    const upload = await OrganizationPublications.create(f.credentials.alice, {
      requestID: crypto.randomUUID(), purpose: "artifact", scope: { kind: "project", projectID: "project" }, sourceSessionID: sessionID,
    })
    const file = await OrganizationPublications.putFile(f.credentials.alice, upload.uploadID, {
      path: "result.txt", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "text/plain",
    })
    await OrganizationPublications.putChunk(f.credentials.alice, upload.uploadID, file.fileID, 0, bytes)
    await OrganizationPublications.seal(f.credentials.alice, upload.uploadID, { fileCount: 1, totalBytes: bytes.length })
    return { upload, file }
  })
}

test("a published artifact survives a private or removed source and retains immutable versions", async () => {
  await using f = await directoryFixture()
  await f.run(() => OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
    sessionID: "source", projectID: "project", runtimeID: "runtime-alice",
  }))
  const first = await upload(f, "first version")
  const input = { requestID: "publish", artifactID: "report", expectedRevision: 0, uploadID: first.upload.uploadID, title: "Team report" }
  const published = await f.run(() => OrganizationArtifacts.publish(f.credentials.alice, input))
  expect(published.version).toBe(1)
  const readerView = await f.run(() => OrganizationArtifacts.get(f.credentials.reader, "report", 1))
  expect(readerView.sourceAvailable).toBe(false)
  expect(readerView.sourceSessionID).toBeUndefined()
  await f.run(() => Storage.remove(OrganizationStoragePath.session("source")))
  expect((await f.run(() => OrganizationArtifacts.get(f.credentials.bob, "report", 1))).manifestHash).toBe(published.manifestHash)
  expect(await f.run(() => OrganizationArtifacts.publish(f.credentials.alice, input))).toMatchObject({ version: 1, manifestHash: published.manifestHash })
  const response = await f.run(() => OrganizationArtifacts.content(f.credentials.reader, "report", 1, first.file.fileID))
  expect(await response.text()).toBe("first version")
  await f.restart()
  expect((await f.run(() => OrganizationArtifacts.list(f.credentials.reader, "project", { limit: 10 }))).items).toHaveLength(1)
})

test("published artifact Range and references authorize the project without leaking the source", async () => {
  await using f = await directoryFixture()
  await f.run(() => OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
    sessionID: "source", projectID: "project", runtimeID: "runtime-alice",
  }))
  const staged = await upload(f, "0123456789")
  await f.run(() => OrganizationArtifacts.publish(f.credentials.alice, {
    requestID: "publish", artifactID: "report", expectedRevision: 0, uploadID: staged.upload.uploadID, title: "Report",
  }))
  const response = await f.run(() => OrganizationArtifacts.content(f.credentials.reader, "report", 1, staged.file.fileID, "bytes=2-5"))
  expect(response.status).toBe(206)
  expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10")
  expect(await response.text()).toBe("2345")
  const invalid = await f.run(() => OrganizationArtifacts.content(f.credentials.reader, "report", 1, staged.file.fileID, "bytes=30-40"))
  expect(invalid.status).toBe(416)
  const reference = await f.run(() => OrganizationArtifacts.reference(f.credentials.reader, "report", 1, { limit: 10 }))
  expect(reference.files).toEqual([staged.file])
  await expect(f.run(() => OrganizationArtifacts.content(f.credentials.outsider, "report", 1, staged.file.fileID))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  await expect(f.run(() => OrganizationArtifacts.publish(f.credentials.reader, {
    requestID: "forged", artifactID: "report", expectedRevision: 1, uploadID: staged.upload.uploadID, title: "Report",
  }))).rejects.toThrow()
})
