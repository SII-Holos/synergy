import { z } from "zod"
import { Storage } from "../storage/storage"
import type { StoreTransaction } from "../storage/transactional-store"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { StorageIntegrityError } from "../storage/errors"
import { SessionChildIndex } from "./child-index"

export async function upgradeChildIndex(tx: StoreTransaction, scopeID: string, parentID: string, value: unknown) {
  const previous = z
    .object({
      version: z.literal(1),
      scopeID: z.string(),
      parentID: z.string(),
      updatedAt: z.number(),
      entries: z.array(SessionChildIndex.Entry),
    })
    .parse(value)
  if (previous.scopeID !== scopeID || previous.parentID !== parentID)
    throw new StorageIntegrityError("Historical child index belongs to another owner")
  return SessionChildIndex.replace(tx, scopeID, parentID, previous.entries)
}

export const sessionChildIndexMigrations: Migration[] = [
  {
    id: "20261111-session-child-index-pages",
    scope: "global",
    execution: "maintenance",
    emptyInput: [["session_child_index"]],
    description: "Replace whole-parent child indexes with versioned metadata and seekable rows",
    async up(progress) {
      let count = 0
      let after: string[] | undefined
      for (;;) {
        const page = await Storage.queryKeys({ prefix: ["session_child_index"], after, limit: 128 })
        for (const key of page)
          if (key.length === 3) {
            await SessionChildIndex.ensure(key[1], key[2])
            progress(++count, count)
          }
        if (page.length < 128) return
        after = page.at(-1)
      }
    },
  },
]

export function registerSessionChildIndexMigrations() {
  MigrationRegistry.register("session-child-index", sessionChildIndexMigrations)
}
