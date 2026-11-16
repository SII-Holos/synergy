import { appliedSelection } from "./support/knowledge"
import { expect, test } from "bun:test"
import { OrganizationKnowledge as Knowledge } from "../src/knowledge"
import { OrganizationPublications as Publications } from "../src/publications"
import { directoryFixture } from "./support/session-directory"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { knowledgeSelectionMigration } from "../src/knowledge-selection"
import { createHash } from "node:crypto"
import { OrganizationKnowledgeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"

async function material(f: Awaited<ReturnType<typeof directoryFixture>>) {
  return f.run(async () => {
    const upload = await Publications.create(f.credentials.alice, {
      requestID: "one-upload",
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
    })
    await Publications.seal(f.credentials.alice, upload.uploadID, { fileCount: 0, totalBytes: 0 })
    const release = await Knowledge.publish(f.credentials.alice, {
      requestID: "one-release",
      itemID: "one",
      expectedRevision: 0,
      uploadID: upload.uploadID,
      title: "One",
      kind: "material",
    })
    return { itemID: release.itemID, version: release.version, manifestHash: release.manifestHash }
  })
}

test("paged knowledge updates preserve an immutable complete selection across retries and competing commits", async () => {
  await using f = await directoryFixture()
  const releases = await f.run(async () => {
    const upload = await Publications.create(f.credentials.alice, {
      requestID: "empty-upload",
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
    })
    await Publications.seal(f.credentials.alice, upload.uploadID, { fileCount: 0, totalBytes: 0 })
    const releases = []
    for (let index = 0; index < 1001; index++)
      releases.push(
        await Knowledge.publish(f.credentials.alice, {
          requestID: `publish-${index}`,
          itemID: `material-${String(index).padStart(6, "0")}`,
          expectedRevision: 0,
          uploadID: upload.uploadID,
          title: `Material ${index}`,
          kind: "material",
        }),
      )
    return releases.map(({ itemID, version, manifestHash }) => ({ itemID, version, manifestHash }))
  })
  const request = {
    requestID: "complete-selection",
    target: { kind: "member" as const, projectID: "project" },
    expectedRevision: 0,
  }
  const first = await f.run(() => Knowledge.beginSelectionUpdate(f.credentials.bob, request))
  expect(await f.run(() => Knowledge.beginSelectionUpdate(f.credentials.bob, request))).toEqual(first)
  let sequence = 0
  for (let start = 0; start < releases.length; start += 100) {
    const input = {
      sequence,
      changes: releases.slice(start, start + 100).map((reference) => ({ itemID: reference.itemID, reference })),
    }
    const page = await f.run(() => Knowledge.patchSelectionUpdate(f.credentials.bob, first.updateID, input))
    expect(await f.run(() => Knowledge.patchSelectionUpdate(f.credentials.bob, first.updateID, input))).toEqual(page)
    sequence++
  }
  expect((await f.run(() => Knowledge.appliedPage(f.credentials.bob, "project", {}))).selection.releaseCount).toBe(0)
  const selected = await f.run(() =>
    Knowledge.commitSelectionUpdate(f.credentials.bob, first.updateID, { expectedSequence: sequence }),
  )
  expect(selected.releaseCount).toBe(releases.length)
  expect(
    await f.run(() =>
      Knowledge.commitSelectionUpdate(f.credentials.bob, first.updateID, { expectedSequence: sequence }),
    ),
  ).toEqual(selected)
  const all = []
  let cursor: string | undefined
  do {
    const page = await f.run(() =>
      Knowledge.appliedPage(f.credentials.bob, "project", { limit: 97, cursor, manifestHash: selected.manifestHash }),
    )
    all.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  expect(all).toEqual(releases)
  const change = await f.run(() =>
    Knowledge.beginSelectionUpdate(f.credentials.bob, {
      ...request,
      requestID: "remove-one",
      expectedRevision: selected.revision,
    }),
  )
  await f.run(() =>
    Knowledge.patchSelectionUpdate(f.credentials.bob, change.updateID, {
      sequence: 0,
      changes: [{ itemID: releases[0]!.itemID }],
    }),
  )
  const competing = await f.run(() =>
    Knowledge.beginSelectionUpdate(f.credentials.bob, {
      ...request,
      requestID: "competing",
      expectedRevision: selected.revision,
    }),
  )
  await f.run(() => Knowledge.commitSelectionUpdate(f.credentials.bob, change.updateID, { expectedSequence: 1 }))
  await expect(
    f.run(() => Knowledge.commitSelectionUpdate(f.credentials.bob, competing.updateID, { expectedSequence: 0 })),
  ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  await f.restart()
  const matching = await f.run(() =>
    Knowledge.appliedReferences(f.credentials.bob, "project", {
      itemIDs: [releases[0]!.itemID, releases.at(-1)!.itemID],
    }),
  )
  expect(matching.selection.releaseCount).toBe(1000)
  expect(matching.items).toEqual([releases.at(-1)!])
}, 60000)

test("staged knowledge publication reauthorizes its owner and every selected release through commit and receipt retries", async () => {
  await using f = await directoryFixture()
  const reference = await material(f)
  const request = {
    requestID: "staged",
    target: { kind: "member" as const, projectID: "project" },
    expectedRevision: 0,
  }
  const update = await f.run(() => Knowledge.beginSelectionUpdate(f.credentials.bob, request))
  await f.run(() =>
    Knowledge.patchSelectionUpdate(f.credentials.bob, update.updateID, {
      sequence: 0,
      changes: [{ itemID: reference.itemID, reference }],
    }),
  )
  await expect(f.run(() => Knowledge.selectionUpdate(f.credentials.alice, update.updateID))).rejects.toMatchObject({
    data: { code: "NOT_FOUND" },
  })
  await expect(
    f.run(() => Knowledge.beginSelectionUpdate(f.credentials.bob, { ...request, expectedRevision: 1 })),
  ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  await expect(
    f.run(() =>
      Knowledge.patchSelectionUpdate(f.credentials.bob, update.updateID, {
        sequence: 0,
        changes: [{ itemID: reference.itemID }],
      }),
    ),
  ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  await f.run(() => Knowledge.withdraw(f.credentials.alice, reference.itemID, 1))
  await expect(
    f.run(() => Knowledge.commitSelectionUpdate(f.credentials.bob, update.updateID, { expectedSequence: 1 })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  expect((await f.run(() => Knowledge.appliedPage(f.credentials.bob, "project", {}))).selection.revision).toBe(0)
  await f.run(() =>
    Knowledge.patchSelectionUpdate(f.credentials.bob, update.updateID, {
      sequence: 1,
      changes: [{ itemID: reference.itemID }],
    }),
  )
  await f.run(() => Knowledge.commitSelectionUpdate(f.credentials.bob, update.updateID, { expectedSequence: 2 }))
  await f.run(() =>
    Storage.transaction(async () => {
      await Storage.remove(Keys.projectMember("project", "bob"))
      await Storage.remove(Keys.projectAccess("bob", "project"))
    }),
  )
  await expect(
    f.run(() => Knowledge.commitSelectionUpdate(f.credentials.bob, update.updateID, { expectedSequence: 2 })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
})

test("a failed manifest pointer commit rolls back its immutable rows and retries the same staged update", async () => {
  const { spyOn } = await import("bun:test")
  await using f = await directoryFixture()
  const reference = await material(f)
  const update = await f.run(() =>
    Knowledge.beginSelectionUpdate(f.credentials.bob, {
      requestID: "atomic",
      target: { kind: "member", projectID: "project" },
      expectedRevision: 0,
    }),
  )
  await f.run(() =>
    Knowledge.patchSelectionUpdate(f.credentials.bob, update.updateID, {
      sequence: 0,
      changes: [{ itemID: reference.itemID, reference }],
    }),
  )
  const original = Storage.write
  let failed = false
  const fault = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    if (
      !failed &&
      JSON.stringify(key) === JSON.stringify(["organization-knowledge", "applied", "org", "bob", "project"])
    ) {
      failed = true
      throw new Error("Synthetic selection pointer failure")
    }
    return original(key, value)
  })
  try {
    await expect(
      f.run(() => Knowledge.commitSelectionUpdate(f.credentials.bob, update.updateID, { expectedSequence: 1 })),
    ).rejects.toThrow("pointer failure")
  } finally {
    fault.mockRestore()
  }
  expect((await f.run(() => Knowledge.appliedPage(f.credentials.bob, "project", {}))).selection.releaseCount).toBe(0)
  expect((await f.run(() => Knowledge.selectionUpdate(f.credentials.bob, update.updateID))).state).toBe("draft")
  const residue = await f.run(async () => {
    const rows = []
    for await (const row of Storage.records({
      prefix: ["organization-knowledge", "manifests", "org", update.updateID],
      limit: 10,
    }))
      rows.push(row)
    return rows
  })
  expect(residue).toEqual([])
  const committed = await f.run(() =>
    Knowledge.commitSelectionUpdate(f.credentials.bob, update.updateID, { expectedSequence: 1 }),
  )
  expect(committed.releaseCount).toBe(1)
})

test("selection migration retains the exact original order and checksum while paging through immutable references", async () => {
  await using f = await directoryFixture()
  const releases = [
    { itemID: "z", version: 2, manifestHash: "a".repeat(64) },
    { itemID: "A", version: 1, manifestHash: "b".repeat(64) },
  ]
  const selection = {
    revision: 7,
    manifestHash: createHash("sha256").update(JSON.stringify(releases)).digest("hex"),
    releases,
    updatedBy: "bob",
    updatedAt: 123,
  }
  const key = ["organization-knowledge", "applied", "org", "bob", "project"]
  await f.run(() => Storage.write(key, { ...selection, schemaVersion: 1, orgID: "org", projectID: "project" }))
  await f.run(() => knowledgeSelectionMigration.up(() => {}))
  expect(await f.run(() => appliedSelection(f.credentials.bob, "project"))).toEqual(selection)
  const first = await f.run(() => Knowledge.appliedPage(f.credentials.bob, "project", { limit: 1 }))
  const second = await f.run(() =>
    Knowledge.appliedPage(f.credentials.bob, "project", {
      limit: 1,
      cursor: first.cursor,
      manifestHash: selection.manifestHash,
    }),
  )
  expect([...first.items, ...second.items]).toEqual(releases)
  expect(await f.run(() => Storage.read(key))).not.toHaveProperty("releases")
  await f.run(() => knowledgeSelectionMigration.up(() => {}))
  expect(await f.run(() => appliedSelection(f.credentials.bob, "project"))).toEqual(selection)
})

test("knowledge selection HTTP uses bounded pages and exposes summaries independently of whole-manifest compatibility reads", async () => {
  await using f = await directoryFixture()
  const reference = await material(f)
  const post = (route: string, input: unknown) =>
    fetch(new URL(`/org/v1${route}`, f.baseUrl), {
      method: "POST",
      headers: {
        ...f.headers("bob"),
        origin: "https://organization.example",
        "x-csrf-token": "f".repeat(64),
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    })
  const started = await post("/knowledge/selection-updates", {
    requestID: "http-update",
    target: { kind: "member", projectID: "project" },
    expectedRevision: 0,
  })
  expect(started.status).toBe(200)
  const update = Protocol.SelectionUpdate.parse(await started.json())
  const patched = await post(`/knowledge/selection-updates/${update.updateID}/pages`, {
    sequence: 0,
    changes: [{ itemID: reference.itemID, reference }],
  })
  expect(patched.status).toBe(200)
  const committed = await post(`/knowledge/selection-updates/${update.updateID}/commit`, { expectedSequence: 1 })
  expect(committed.status).toBe(200)
  expect(Protocol.SelectionSummary.parse(await committed.json()).releaseCount).toBe(1)
  const page = await f.request("bob", "/projects/project/knowledge/applied/releases?limit=1")
  expect(page.status).toBe(200)
  expect(Protocol.SelectionPage.parse(await page.json()).items).toEqual([reference])
  const matching = await post("/projects/project/knowledge/applied/references", { itemIDs: [reference.itemID] })
  expect(matching.status).toBe(200)
  expect(Protocol.SelectionPage.parse(await matching.json()).items).toEqual([reference])
  const oversized = await post(`/knowledge/selection-updates/${update.updateID}/pages`, {
    sequence: 1,
    changes: Array.from({ length: 101 }, (_, index) => ({ itemID: `item-${index}` })),
  })
  expect(oversized.status).toBe(400)
})
