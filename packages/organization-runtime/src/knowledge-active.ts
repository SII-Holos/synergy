import { z } from "zod"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"

export namespace ActiveKnowledgeStore {
  export const CachedRelease = z.strictObject({ release: Knowledge.Release, directory: z.string() })
  export type CachedRelease = z.infer<typeof CachedRelease>
  export const Header = z.strictObject({
    schemaVersion: z.literal(2),
    orgID: Identity.ID,
    projectID: Identity.ID,
    sessionID: Identity.ID,
    manifestID: Identity.ID,
    selection: Knowledge.SelectionSummary,
  })
  export type Header = z.infer<typeof Header>
  export const key = (sessionID: string) => ["organization-knowledge", "active", Identity.ID.parse(sessionID)]
  export const root = (header: Pick<Header, "orgID" | "projectID" | "sessionID" | "manifestID">) => [
    "organization-knowledge",
    "active-manifests",
    header.orgID,
    header.projectID,
    header.sessionID,
    header.manifestID,
  ]
  const position = (ordinal: number) => String(ordinal).padStart(16, "0")
  const item = (header: Header, itemID: string) => [...root(header), "items", itemID]
  const release = (header: Header, ordinal: number) => [...root(header), "releases", position(ordinal)]
  const Seal = z.strictObject({ manifestHash: z.string(), releaseCount: z.number().int().nonnegative().safe() })

  export async function sealed(header: Header) {
    const [value] = await Storage.readMany([[...root(header), "seal"]])
    if (value === undefined) return false
    const seal = Seal.parse(value)
    if (seal.manifestHash !== header.selection.manifestHash || seal.releaseCount !== header.selection.releaseCount)
      throw new Error("Knowledge immutable manifest seal changed")
    return true
  }

  export async function read(sessionID: string) {
    const [value] = await Storage.readMany([key(sessionID)])
    return value === undefined ? undefined : Header.parse(value)
  }
  export async function put(header: Header, ordinal: number, value: CachedRelease) {
    return Storage.transaction(async () => {
      const cached = CachedRelease.parse(value)
      if (
        cached.release.orgID !== header.orgID ||
        (cached.release.scope.kind === "project" && cached.release.scope.projectID !== header.projectID)
      )
        throw new Error("Knowledge release is outside its manifest project")
      const path = release(header, ordinal)
      const [previous, existing] = await Storage.readMany([path, item(header, cached.release.itemID)])
      if (
        (previous !== undefined && !isDeepStrictEqual(previous, cached)) ||
        (existing !== undefined && existing !== ordinal)
      )
        throw new Error("Knowledge staging repeats or changes an immutable release")
      if (await sealed(header)) {
        if (previous === undefined || existing === undefined)
          throw new Error("A sealed knowledge manifest cannot add releases")
        return
      }
      await Storage.write(path, cached)
      await Storage.write(item(header, cached.release.itemID), ordinal)
    })
  }
  export async function selected(header: Header, itemID: string) {
    const [ordinal] = await Storage.readMany([item(header, Identity.ID.parse(itemID))])
    if (ordinal === undefined) return undefined
    const value = CachedRelease.parse(
      await Storage.read(release(header, z.number().int().nonnegative().safe().parse(ordinal))),
    )
    if (value.release.itemID !== itemID) throw new Error("Knowledge selection item index changed")
    return value
  }
  export async function page(header: Header, query: { cursor?: string; limit?: number } = {}) {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(query.limit ?? 50)
    let after: string[] | undefined
    if (query.cursor) {
      const [ordinal] = await Storage.readMany([item(header, query.cursor)])
      if (ordinal === undefined) throw new Error("Knowledge cursor is outside its active manifest")
      after = release(header, z.number().int().nonnegative().safe().parse(ordinal))
    }
    const rows = await Storage.query({ prefix: [...root(header), "releases"], after, limit: limit + 1 })
    const items = rows.slice(0, limit).map((row) => CachedRelease.parse(row.value))
    return { items, ...(rows.length > items.length ? { cursor: items.at(-1)!.release.itemID } : {}) }
  }
  export async function* releases(header: Header) {
    let count = 0
    for await (const row of Storage.records({ prefix: [...root(header), "releases"], limit: 100 })) {
      if (row.key.at(-1) !== position(count++)) throw new Error("Knowledge active manifest order is incomplete")
      yield CachedRelease.parse(row.value)
    }
    if (count !== header.selection.releaseCount) throw new Error("Knowledge active manifest count changed")
  }
  export async function seal(header: Header) {
    return Storage.transaction(async () => {
      const hash = createHash("sha256").update("[")
      let count = 0
      for await (const cached of releases(header)) {
        if (count++) hash.update(",")
        hash.update(
          JSON.stringify({
            itemID: cached.release.itemID,
            version: cached.release.version,
            manifestHash: cached.release.manifestHash,
          }),
        )
      }
      if (hash.update("]").digest("hex") !== header.selection.manifestHash)
        throw new Error("Knowledge active manifest checksum changed")
      await Storage.write(
        [...root(header), "seal"],
        Seal.parse({ manifestHash: header.selection.manifestHash, releaseCount: count }),
      )
    })
  }
}

const Legacy = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  projectID: Identity.ID,
  sessionID: Identity.ID,
  selection: Knowledge.Selection,
  releases: z.array(ActiveKnowledgeStore.CachedRelease),
})
export const knowledgeActiveMigration: Migration = {
  id: "20261111-organization-knowledge-active-pages-v2",
  description: "Retain active knowledge release rows behind a bounded atomic manifest pointer",
  scope: "global",
  execution: "maintenance",
  emptyInput: [["organization-knowledge", "active"]],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["organization-knowledge", "active"], limit: 100 })) {
      if (row.key.length !== 3) continue
      await Storage.transaction(async () => {
        const raw = await Storage.read(row.key)
        if (ActiveKnowledgeStore.Header.safeParse(raw).success) return
        const value = Legacy.parse(raw)
        const references = value.releases.map(({ release }) => ({
          itemID: release.itemID,
          version: release.version,
          manifestHash: release.manifestHash,
        }))
        if (
          value.sessionID !== row.key[2] ||
          JSON.stringify(value.selection.releases) !== JSON.stringify(references) ||
          createHash("sha256").update(JSON.stringify(references)).digest("hex") !== value.selection.manifestHash
        )
          throw new Error("Retained active knowledge selection is inconsistent")
        const { releases, ...selection } = value.selection
        const header = ActiveKnowledgeStore.Header.parse({
          schemaVersion: 2,
          orgID: value.orgID,
          projectID: value.projectID,
          sessionID: value.sessionID,
          manifestID: createHash("sha256")
            .update(JSON.stringify([value.orgID, value.projectID, value.selection.manifestHash]))
            .digest("hex"),
          selection: { ...selection, releaseCount: releases.length },
        })
        for (const [ordinal, cached] of value.releases.entries())
          await ActiveKnowledgeStore.put(header, ordinal, cached)
        await ActiveKnowledgeStore.seal(header)
        await Storage.write(row.key, header)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}

export function registerKnowledgeActiveMigrations() {
  MigrationRegistry.register("organization-knowledge-runtime", [knowledgeActiveMigration])
}
