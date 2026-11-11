import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { fail } from "./error"

export namespace KnowledgeSelections {
  export const Header = Knowledge.SelectionSummary.extend({
    schemaVersion: z.literal(2),
    orgID: Identity.ID,
    projectID: Identity.ID,
    manifestID: Identity.ID,
  })
  export type Header = z.infer<typeof Header>
  const root = (header: Pick<Header, "orgID" | "manifestID">) => [
    "organization-knowledge",
    "manifests",
    header.orgID,
    header.manifestID,
  ]
  const position = (value: number) => String(value).padStart(16, "0")
  const referenceKey = (header: Header, ordinal: number) => [...root(header), "references", position(ordinal)]
  const itemKey = (header: Header, itemID: string) => [...root(header), "items", itemID]

  export function empty(orgID: string, projectID: string, accountID: string): Header {
    return Header.parse({
      schemaVersion: 2,
      orgID,
      projectID,
      manifestID: "empty",
      revision: 0,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      releaseCount: 0,
      updatedBy: accountID,
      updatedAt: 0,
    })
  }
  export function summary(header: Header) {
    return Knowledge.SelectionSummary.parse(Knowledge.SelectionSummary.strip().parse(header))
  }
  export function authority(value: unknown) {
    const current = Header.safeParse(value)
    if (current.success) {
      const { orgID, projectID, revision, manifestHash, releaseCount } = current.data
      return { orgID, projectID, revision, manifestHash, releaseCount }
    }
    const legacy = Legacy.parse(value)
    if (createHash("sha256").update(JSON.stringify(legacy.releases)).digest("hex") !== legacy.manifestHash)
      fail("SERVICE_UNAVAILABLE", "Retained knowledge manifest is inconsistent")
    return {
      orgID: legacy.orgID,
      projectID: legacy.projectID,
      revision: legacy.revision,
      manifestHash: legacy.manifestHash,
      releaseCount: legacy.releases.length,
    }
  }
  export async function read(key: string[]) {
    const [value] = await Storage.readMany([key])
    return value === undefined ? undefined : Header.parse(value)
  }
  export async function put(header: Header, ordinal: number, value: Knowledge.Reference) {
    if (!Storage.inWriteTransaction())
      throw new Error("Knowledge manifest publication requires its pointer transaction")
    const reference = Knowledge.Reference.parse(value)
    const item = itemKey(header, reference.itemID)
    const [existing] = await Storage.readMany([item])
    if (existing !== undefined && existing !== ordinal) fail("REVISION_CONFLICT", "Knowledge manifest repeats an item")
    await Storage.write(item, ordinal)
    await Storage.write(referenceKey(header, ordinal), reference)
  }
  export async function reference(header: Header, itemID: string) {
    const [ordinal] = await Storage.readMany([itemKey(header, Identity.ID.parse(itemID))])
    if (ordinal === undefined) return undefined
    const value = Knowledge.Reference.parse(
      await Storage.read(referenceKey(header, z.number().int().nonnegative().safe().parse(ordinal))),
    )
    if (value.itemID !== itemID) fail("SERVICE_UNAVAILABLE", "Knowledge manifest item index changed")
    return value
  }
  export async function* references(header: Header) {
    let count = 0
    const hash = createHash("sha256").update("[")
    for await (const row of Storage.records({ prefix: [...root(header), "references"], limit: 100 })) {
      if (row.key.at(-1) !== position(count)) fail("SERVICE_UNAVAILABLE", "Knowledge manifest order is incomplete")
      const value = Knowledge.Reference.parse(row.value)
      if (count) hash.update(",")
      hash.update(JSON.stringify(value))
      count++
      yield value
    }
    if (count !== header.releaseCount || hash.update("]").digest("hex") !== header.manifestHash)
      fail("SERVICE_UNAVAILABLE", "Knowledge manifest checksum or count changed")
  }
  export async function page(header: Header, input: z.input<typeof Knowledge.SelectionPageQuery>) {
    const query = Knowledge.SelectionPageQuery.parse(input)
    if (query.manifestHash && query.manifestHash !== header.manifestHash)
      fail("REVISION_CONFLICT", "Knowledge selection changed during pagination")
    let after: string[] | undefined
    if (query.cursor) {
      const [ordinal] = await Storage.readMany([itemKey(header, query.cursor)])
      if (ordinal === undefined) fail("INVALID_REQUEST", "Knowledge selection cursor is outside its manifest")
      after = referenceKey(header, z.number().int().nonnegative().parse(ordinal))
    }
    const rows = await Storage.query({ prefix: [...root(header), "references"], after, limit: query.limit + 1 })
    const items = rows.slice(0, query.limit).map((row) => Knowledge.Reference.parse(row.value))
    return Knowledge.SelectionPage.parse({
      selection: summary(header),
      items,
      cursor: rows.length > items.length ? items.at(-1)?.itemID : undefined,
    })
  }
  export async function selected(header: Header, input: z.infer<typeof Knowledge.SelectionReferences>) {
    const query = Knowledge.SelectionReferences.parse(input)
    if (query.manifestHash && query.manifestHash !== header.manifestHash)
      fail("REVISION_CONFLICT", "Knowledge selection changed during lookup")
    const items: Knowledge.Reference[] = []
    for (const itemID of query.itemIDs) {
      const value = await reference(header, itemID)
      if (value) items.push(value)
    }
    return Knowledge.SelectionPage.parse({ selection: summary(header), items })
  }
}

const Legacy = Knowledge.Selection.extend({ schemaVersion: z.literal(1), orgID: Identity.ID, projectID: Identity.ID })
export const knowledgeSelectionMigration: Migration = {
  id: "20261111-organization-knowledge-selection-pages-v2",
  description:
    "Move retained knowledge selections into immutable paged manifests without changing their exact references",
  scope: "global",
  execution: "maintenance",
  emptyInput: [["organization-knowledge"]],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["organization-knowledge"], limit: 100 })) {
      if (!["applied", "sessions", "activated"].includes(row.key[1])) continue
      await Storage.transaction(async () => {
        const current = await Storage.read<unknown>(row.key)
        if (KnowledgeSelections.Header.safeParse(current).success) return
        const legacy = Legacy.parse(current)
        const { releases, ...metadata } = legacy
        const header = KnowledgeSelections.Header.parse({
          ...metadata,
          schemaVersion: 2,
          manifestID: createHash("sha256").update(JSON.stringify(row.key)).digest("hex"),
          releaseCount: releases.length,
        })
        if (createHash("sha256").update(JSON.stringify(releases)).digest("hex") !== header.manifestHash)
          fail("SERVICE_UNAVAILABLE", "Retained knowledge manifest is inconsistent")
        for (const [ordinal, reference] of releases.entries()) await KnowledgeSelections.put(header, ordinal, reference)
        await Storage.write(row.key, header)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
