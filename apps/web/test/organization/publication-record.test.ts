import { expect, test } from "bun:test"
import {
  preparePublicationRecord,
  publicationAttempt,
  publicationFailed,
  publicationConfirmed,
  PublicationRecord,
} from "../../src/organization/publication-record"

export function record() {
  return preparePublicationRecord({
    identity: { kind: "organization", orgID: "org", accountID: "alice", deploymentIncarnation: "deployment" },
    source: { scope: { kind: "project", projectID: "project" } },
    upload: {
      uploadID: "sealed",
      orgID: "org",
      authorID: "alice",
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
      state: "sealed",
      manifestHash: "a".repeat(64),
      fileCount: 1,
      totalBytes: 12,
      createdAt: 1,
    },
    publication: {
      purpose: "knowledge",
      request: {
        requestID: "original",
        itemID: "item",
        expectedRevision: 0,
        uploadID: "sealed",
        title: "Original title",
        kind: "material",
      },
    },
    createdAt: 1,
  })
}

test("a publication with any historical unknown cannot become not dispatched after a later attempt", () => {
  const first = publicationAttempt(record())
  expect(publicationFailed(first, true).state).toBe("not_dispatched")
  const unknown = publicationFailed(first, false)
  expect(unknown.state).toBe("unknown")
  expect(publicationFailed(publicationAttempt(unknown), true).state).toBe("unknown")
  const reloaded = PublicationRecord.parse(JSON.parse(JSON.stringify(first)))
  expect(publicationFailed(publicationAttempt(reloaded), true).state).toBe("unknown")
  expect(publicationAttempt(unknown).request).toEqual(first.request)
})

test("publication metadata captures the exact sealed source without retaining files or credentials", () => {
  const original = record()
  const copied = PublicationRecord.parse(original)
  original.request.title = "Changed caller"
  original.identity.accountID = "bob"
  expect(copied.request.title).toBe("Original title")
  expect(copied.identity.accountID).toBe("alice")
  for (const changed of [
    { request: { ...copied.request, title: "Changed" } },
    { identity: { ...copied.identity, deploymentIncarnation: "other" } },
    { upload: { ...copied.upload, state: "open" } },
    { body: new Uint8Array([1]) },
    { token: "secret" },
  ])
    expect(PublicationRecord.safeParse({ ...copied, ...changed }).success).toBe(false)
})

test("only the exact author, target and sealed file summary can confirm publication", () => {
  const pending = record()
  const release = {
    itemID: "item",
    orgID: "org",
    scope: { kind: "project", projectID: "project" },
    kind: "material",
    title: "Original title",
    version: 1,
    authorID: "alice",
    publishedAt: 2,
    manifestHash: "a".repeat(64),
    fileCount: 1,
    totalBytes: 12,
  } as const
  expect(publicationConfirmed(pending, release)).toEqual(release)
  for (const changed of [
    { itemID: "other" },
    { authorID: "bob" },
    { title: "Later title" },
    { totalBytes: 13 },
    { manifestHash: "b".repeat(64) },
  ])
    expect(() => publicationConfirmed(pending, { ...release, ...changed })).toThrow()
})
