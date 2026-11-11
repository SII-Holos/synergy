import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecord } from "../src/storage/records"
import { OrganizationStoragePath } from "../src/storage/path"
import { OrganizationPublications } from "../src/publications"
import { OrganizationKnowledge } from "../src/knowledge"
import { directoryFixture } from "./support/session-directory"

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

async function skillUpload(
  f: Awaited<ReturnType<typeof directoryFixture>>,
  text: string,
  actor: "alice" | "bob" = "alice",
) {
  return f.run(async () => {
    const bytes = new TextEncoder().encode(text)
    const upload = await OrganizationPublications.create(f.credentials[actor], {
      requestID: crypto.randomUUID(),
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
    })
    const file = await OrganizationPublications.putFile(f.credentials[actor], upload.uploadID, {
      path: "SKILL.md",
      bytes: bytes.length,
      sha256: hash(bytes),
      mediaType: "text/markdown",
    })
    await OrganizationPublications.putChunk(f.credentials[actor], upload.uploadID, file.fileID, 0, bytes)
    return OrganizationPublications.seal(f.credentials[actor], upload.uploadID, {
      fileCount: 1,
      totalBytes: bytes.length,
    })
  })
}

const skill = (body: string) => `---\nname: team-work\ndescription: Team work instructions\n---\n${body}\n`

describe("organization knowledge releases", () => {
  test("publishing is immutable and does not change a member's applied release", async () => {
    await using f = await directoryFixture()
    const first = await skillUpload(f, skill("Version one"))
    const release = await f.run(() => OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "publish-one", itemID: "skill-one", expectedRevision: 0, uploadID: first.uploadID,
      title: "Team work", kind: "skill",
    }))
    expect(release.version).toBe(1)
    const applied = await f.run(() => OrganizationKnowledge.apply(f.credentials.bob, "project", {
      expectedRevision: 0,
      releases: [{ itemID: release.itemID, version: release.version, manifestHash: release.manifestHash }],
    }))
    const second = await skillUpload(f, skill("Version two"))
    await f.run(() => OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "publish-two", itemID: "skill-one", expectedRevision: 1, uploadID: second.uploadID,
      title: "Team work", kind: "skill",
    }))
    expect((await f.run(() => OrganizationKnowledge.applied(f.credentials.bob, "project"))).releases).toEqual(applied.releases)
    const old = await f.run(() => OrganizationKnowledge.get(f.credentials.reader, "skill-one", 1))
    expect(old.manifestHash).toBe(release.manifestHash)
    expect(old.version).toBe(1)
    await expect(f.run(() => OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "publish-one", itemID: "skill-one", expectedRevision: 0, uploadID: second.uploadID,
      title: "Team work", kind: "skill",
    }))).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  })

  test("failed and competing updates retain the complete previous selection across restart", async () => {
    await using f = await directoryFixture()
    const upload = await skillUpload(f, skill("Version one"))
    const release = await f.run(() => OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "publish", itemID: "skill-one", expectedRevision: 0, uploadID: upload.uploadID,
      title: "Team work", kind: "skill",
    }))
    const selected = { itemID: release.itemID, version: release.version, manifestHash: release.manifestHash }
    const applied = await f.run(() => OrganizationKnowledge.apply(f.credentials.bob, "project", { expectedRevision: 0, releases: [selected] }))
    await expect(f.run(() => OrganizationKnowledge.apply(f.credentials.bob, "project", {
      expectedRevision: applied.revision, releases: [selected, { itemID: "missing", version: 1, manifestHash: "a".repeat(64) }],
    }))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    await expect(f.run(() => OrganizationKnowledge.apply(f.credentials.bob, "project", {
      expectedRevision: 0, releases: [],
    }))).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    await f.restart()
    expect(await f.run(() => OrganizationKnowledge.applied(f.credentials.bob, "project"))).toEqual(applied)
  })

  test("publication, retrieval and search recheck current scope permissions", async () => {
    await using f = await directoryFixture()
    const upload = await skillUpload(f, skill("private team material"))
    await f.run(() => OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "publish", itemID: "private-skill", expectedRevision: 0, uploadID: upload.uploadID,
      title: "Private team material", kind: "skill",
    }))
    expect((await f.run(() => OrganizationKnowledge.search(f.credentials.reader, { projectID: "project", q: "Private", limit: 10 }))).items).toHaveLength(1)
    await expect(f.run(() => OrganizationKnowledge.get(f.credentials.outsider, "private-skill"))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    await expect(f.run(() => OrganizationKnowledge.apply(f.credentials.reader, "project", { expectedRevision: 0, releases: [] }))).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await f.run(() => Storage.remove(OrganizationStoragePath.projectMember("project", "reader")))
    await expect(f.run(() => OrganizationKnowledge.search(f.credentials.reader, { projectID: "project", q: "Private", limit: 10 }))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  })

  test("invalid Skill manifests never become published versions", async () => {
    await using f = await directoryFixture()
    const upload = await skillUpload(f, "---\nname: INVALID NAME\n---\ninvalid")
    await expect(f.run(() => OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "invalid", itemID: "invalid-skill", expectedRevision: 0, uploadID: upload.uploadID,
      title: "Invalid", kind: "skill",
    }))).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
    expect((await f.run(() => OrganizationKnowledge.list(f.credentials.alice, { projectID: "project", limit: 10 }))).items).toHaveLength(0)
  })

  test("shared Session selections are independent and retain their updater", async () => {
    await using f = await directoryFixture()
    const upload = await skillUpload(f, skill("Version one"))
    const release = await f.run(() => OrganizationKnowledge.publish(f.credentials.alice, {
      requestID: "publish", itemID: "skill", expectedRevision: 0, uploadID: upload.uploadID,
      title: "Team work", kind: "skill",
    }))
    await f.run(async () => {
      for (const sessionID of ["one", "two"]) await Storage.write(OrganizationStoragePath.session(sessionID), OrganizationRecord.SessionDirectory.parse({
        schemaVersion: 2, sessionID, projectID: "project", creatorID: "alice", driverRuntimeID: "runtime-alice",
        bindingEpoch: 1, nextBindingEpoch: 2, createdAt: 1, shareState: "shared", resourceIDs: [],
        orgID: "org", shareGeneration: 1, controlRevision: 0, rowRevision: 1, retainedExecutionGrants: 0,
      }))
    })
    const selection = await f.run(() => OrganizationKnowledge.setSessionSelection(f.credentials.bob, "one", {
      expectedRevision: 0, releases: [{ itemID: release.itemID, version: 1, manifestHash: release.manifestHash }],
    }))
    expect(selection.updatedBy).toBe("bob")
    expect((await f.run(() => OrganizationKnowledge.sessionSelection(f.credentials.reader, "one"))).releases).toHaveLength(1)
    expect((await f.run(() => OrganizationKnowledge.sessionSelection(f.credentials.reader, "two"))).releases).toEqual([])
  })
})
