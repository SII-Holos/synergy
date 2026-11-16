import { z } from "zod"
import { Storage } from "../storage/storage"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"

const Component = z.string().regex(/^[a-zA-Z0-9_-]+$/)

function upgrade(key: string[], record: Record<string, unknown>) {
  if (key.length !== 4 || key[0] !== "snapshot-v2" || !["owners", "deletions"].includes(key[2])) return
  if (record.version !== 2) return
  Component.parse(key[1])
  Component.parse(key[3])
  if (Object.hasOwn(record, "retentionID"))
    throw new Error("Legacy snapshot ownership cannot grant retention indirection")
  record.retentionID = key[3]
  record.version = 3
}

export const snapshotOwnershipMigrations: Migration[] = [
  {
    id: "20261111-snapshot-retention-identity",
    description: "Version canonical Snapshot ownership and preserve legacy self-retention",
    execution: "record",
    scope: "global",
    emptyInput: [["snapshot-v2"]],
    upgradeRecord: upgrade,
    async up(progress) {
      let count = 0
      for await (const row of Storage.records<Record<string, unknown>>({ prefix: ["snapshot-v2"], limit: 128 })) {
        const before = JSON.stringify(row.value)
        upgrade(row.key, row.value)
        if (before !== JSON.stringify(row.value)) await Storage.write(row.key, row.value)
        progress(++count, count)
      }
    },
  },
]

export function registerSnapshotOwnershipMigrations() {
  MigrationRegistry.register("snapshot-ownership", snapshotOwnershipMigrations)
}
