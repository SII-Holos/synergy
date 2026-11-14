import { expect } from "bun:test"
import { createHash } from "node:crypto"
import type { OrganizationArtifactProtocol as Artifact } from "@ericsanchezok/synergy-organization-protocol"
import type { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import type { completedHostedTask } from "./hosted-task"
import type { fixture } from "./organization"

type ServiceFixture = Awaited<ReturnType<typeof fixture>>
export async function publishArtifactHistory(
  source: ServiceFixture,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
  first = 1,
  last = 2,
) {
  const options = { headers: source.headers, throwOnError: true as const }
  const versions = []
  for (let version = first; version <= last; version++) {
    const bytes = Uint8Array.from([0, 255, version, 11, 43, 74, 98, 201])
    const upload = (
      await source.client.orgPublications.createUpload(
        {
          requestID: "artifact-upload-" + version,
          purpose: "artifact",
          scope: { kind: "project", projectID: task.target.projectID },
          sourceSessionID: task.sessionID,
        },
        options,
      )
    ).data
    const file = (
      await source.client.orgPublications.putFile(
        {
          uploadID: upload.uploadID,
          path: "results/output.bin",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mediaType: "application/octet-stream",
        },
        options,
      )
    ).data
    await source.client.orgPublications.putChunk(
      { uploadID: upload.uploadID, fileID: file.fileID, offset: 0, body: new Blob([bytes]) },
      options,
    )
    await source.client.orgPublications.seal(
      { uploadID: upload.uploadID, fileCount: 1, totalBytes: bytes.length },
      options,
    )
    const request: Artifact.Publish = {
      requestID: "artifact-publish-" + version,
      artifactID: "original-output",
      expectedRevision: version - 1,
      uploadID: upload.uploadID,
      title: "Original output " + version,
    }
    const published = (await source.client.orgArtifacts.publish(request, options)).data
    expect(published).toMatchObject({ version, sourceSessionID: task.sessionID, sourceAvailable: true })
    versions.push({ request, published, file, bytes })
  }
  return versions
}

export async function verifyArtifactHistory(
  source: ServiceFixture,
  service: Awaited<ReturnType<typeof openOrganizationService>>,
  versions: Awaited<ReturnType<typeof publishArtifactHistory>>,
) {
  const login = await source.client.orgAuth.login(
    { orgLoginInput: { loginName: "owner", password: "a long integration password" } },
    { throwOnError: true },
  )
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("Restored service did not issue its actual owner login")
  const headers = { cookie, "x-csrf-token": login.data.csrfToken }
  const options = { headers, throwOnError: true as const }
  for (const value of versions) {
    const target = { artifactID: value.published.artifactID, version: value.published.version }
    expect((await source.client.orgArtifacts.version(target, options)).data).toEqual(value.published)
    expect((await source.client.orgArtifacts.publicationReceipt(value.request, options)).data).toEqual({
      state: "published",
      version: value.published,
    })
    expect((await source.client.orgArtifacts.reference(target, options)).data.files).toEqual([value.file])
    const url =
      source.origin +
      `/org/v1/artifacts/${target.artifactID}/versions/${target.version}/files/${value.file.fileID}/content`
    const response = await service.fetch(new Request(url, { headers }))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(value.bytes)
    const range = await service.fetch(new Request(url, { headers: { ...headers, range: "bytes=1-4" } }))
    expect(range.status).toBe(206)
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(value.bytes.slice(1, 5))
  }
}
