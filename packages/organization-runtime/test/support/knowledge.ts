import { createHash } from "node:crypto"
import { OrganizationKnowledgeProtocol as Knowledge } from "@ericsanchezok/synergy-organization-protocol"
import type { fixture } from "./organization"

type KnowledgeService = Pick<Awaited<ReturnType<typeof fixture>>, "client" | "headers">
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export async function applySelection(
  f: KnowledgeService,
  input: { projectID: string; expectedRevision: number; releases: Knowledge.Reference[] },
) {
  const options = { headers: f.headers, throwOnError: true as const }
  const update = (
    await f.client.orgKnowledge.beginSelectionUpdate(
      {
        requestID: crypto.randomUUID(),
        target: { kind: "member", projectID: input.projectID },
        expectedRevision: input.expectedRevision,
      },
      options,
    )
  ).data
  const previous: Knowledge.Reference[] = []
  let cursor: string | undefined
  do {
    const page = (await f.client.orgKnowledge.appliedPage({ projectID: input.projectID, cursor, limit: 100 }, options))
      .data
    previous.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  const selected = new Set(input.releases.map((reference) => reference.itemID))
  const changes = [
    ...previous
      .filter((reference) => !selected.has(reference.itemID))
      .map((reference) => ({ itemID: reference.itemID })),
    ...input.releases.map((reference) => ({ itemID: reference.itemID, reference })),
  ]
  let sequence = 0
  for (let start = 0; start < changes.length; start += 100)
    await f.client.orgKnowledge.patchSelectionUpdate(
      { updateID: update.updateID, sequence: sequence++, changes: changes.slice(start, start + 100) },
      options,
    )
  return (
    await f.client.orgKnowledge.commitSelectionUpdate(
      { updateID: update.updateID, expectedSequence: sequence },
      options,
    )
  ).data
}

export async function publish(f: KnowledgeService, projectID: string, body: string, expectedRevision: number) {
  const options = { headers: f.headers, throwOnError: true as const }
  const upload = (
    await f.client.orgPublications.createUpload(
      { requestID: crypto.randomUUID(), purpose: "knowledge", scope: { kind: "project", projectID } },
      options,
    )
  ).data
  const file = (
    await f.client.orgPublications.putFile(
      {
        uploadID: upload.uploadID,
        path: "SKILL.md",
        bytes: Buffer.byteLength(body),
        sha256: hash(body),
        mediaType: "text/markdown",
      },
      options,
    )
  ).data
  await f.client.orgPublications.putChunk(
    { uploadID: upload.uploadID, fileID: file.fileID, offset: 0, body: new Blob([body]) },
    options,
  )
  await f.client.orgPublications.seal(
    { uploadID: upload.uploadID, fileCount: 1, totalBytes: Buffer.byteLength(body) },
    options,
  )
  const release = (
    await f.client.orgKnowledge.publish(
      {
        requestID: crypto.randomUUID(),
        itemID: "team",
        expectedRevision,
        uploadID: upload.uploadID,
        title: "Team",
        kind: "skill",
      },
      options,
    )
  ).data
  const reference = Knowledge.Reference.parse({
    itemID: release.itemID,
    version: release.version,
    manifestHash: release.manifestHash,
  })
  return { release, reference, file }
}
