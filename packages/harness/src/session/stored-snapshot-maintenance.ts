import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { UpgradeWork } from "../storage/upgrade-work"
import { StorageMutationGuard } from "../storage/mutation-guard"
import { StoragePath } from "../storage/path"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotStore } from "./snapshot-store"
import { StoredSnapshotContent as Content } from "./stored-snapshot-content"

export namespace StoredSnapshotMaintenance {
  const Intent = z.strictObject({
    version: z.literal(1),
    scopeID: z.string(),
    retentionID: z.string(),
    ownerSessionID: z.string().optional(),
    root: z.string(),
    contentID: z.string(),
    runtimeID: z.string(),
    createdAt: z.number().int().nonnegative(),
  })
  export type Intent = z.infer<typeof Intent>
  const pendingKey = (intent: Pick<Intent, "scopeID" | "retentionID" | "contentID">) => [
    "stored_snapshot_preparation",
    intent.scopeID,
    intent.retentionID,
    intent.contentID,
  ]
  export async function begin(scopeID: string, retentionID: string, root: string, ownerSessionID?: string) {
    const contentID = randomUUID()
    Content.contentKey(scopeID, retentionID, { root, contentID })
    const intent = Intent.parse({
      version: 1,
      scopeID,
      retentionID,
      ownerSessionID,
      root,
      contentID,
      runtimeID: RuntimeContext.current().id,
      createdAt: Date.now(),
    })
    await Storage.write(pendingKey(intent), intent)
    return intent
  }
  export async function publish(
    intent: Intent,
    header: Content.Header,
    expected?: Content.LegacyManifest,
    signal?: AbortSignal,
    commitGuard?: () => void,
  ) {
    const assert = () => {
      signal?.throwIfAborted()
      commitGuard?.()
    }
    assert()
    if (header.root !== intent.root || header.contentID !== intent.contentID)
      throw new Error("Snapshot publication belongs to another preparation")
    return Storage.transaction(
      async (tx) => {
        assert()
        if (intent.ownerSessionID) {
          const owner = await SnapshotStore.owner(intent.scopeID, intent.ownerSessionID)
          if (!owner || owner.retentionID !== intent.retentionID)
            throw new Error("Snapshot owner changed during publication")
          if (owner.backend === "deleted") throw new Error("Snapshot owner was deleted during publication")
          await StorageMutationGuard.assert(
            tx,
            [StoragePath.snapshotOwner(intent.scopeID, intent.ownerSessionID)],
            false,
          )
        }
        const current = await Content.read(intent.scopeID, intent.retentionID, intent.root)
        if (expected) {
          if (JSON.stringify(current) !== JSON.stringify(expected))
            throw new Error("Legacy Snapshot changed before its manifest upgrade")
        } else if (current) return false
        await Storage.write([...Content.key(intent.scopeID, intent.retentionID, intent.root), "manifest"], header)
        await Storage.write(Content.legacyFenceKey(intent.scopeID, intent.retentionID, intent.root), { version: 1 })
        await Storage.remove(pendingKey(intent))
        return true
      },
      { commitGuard: assert },
    )
  }
  export async function discard(intent: Intent) {
    return Storage.transaction(async () => {
      const current = await Content.read(intent.scopeID, intent.retentionID, intent.root)
      if (current?.version === 2 && current.contentID === intent.contentID) {
        await Storage.remove(pendingKey(intent))
        return false
      }
      await Storage.removeTree(Content.contentKey(intent.scopeID, intent.retentionID, intent))
      await Storage.remove(pendingKey(intent))
      return true
    })
  }
  export async function collect(scopeID: string, retentionID: string, signal?: AbortSignal) {
    SnapshotStore.component(scopeID)
    SnapshotStore.component(retentionID)
    let removed = 0
    await SnapshotLease.use(
      scopeID,
      true,
      async () => {
        const prefix = ["stored_snapshot_preparation", scopeID, retentionID]
        for await (const row of Storage.records({ prefix, limit: 128 })) {
          signal?.throwIfAborted()
          const intent = Intent.parse(row.value)
          if (
            JSON.stringify(row.key) !== JSON.stringify(pendingKey(intent)) ||
            intent.scopeID !== scopeID ||
            intent.retentionID !== retentionID
          )
            throw new Error("Snapshot preparation index contains foreign ownership")
          await withFileLock(
            {
              directory: SnapshotLease.directory(),
              key: `snapshot-content:${scopeID}:${retentionID}:${intent.root}`,
              signal,
            },
            async () => {
              if (await discard(intent)) removed++
            },
          )
        }
      },
      { signal },
    )
    return { removed }
  }
  export async function upgrade(scopeID: string, retentionID: string, root: string, signal?: AbortSignal) {
    return SnapshotLease.use(
      scopeID,
      false,
      () =>
        withFileLock(
          { directory: SnapshotLease.directory(), key: `snapshot-content:${scopeID}:${retentionID}:${root}`, signal },
          async () => {
            const previous = await Content.read(scopeID, retentionID, root)
            if (!previous || previous.version === 2) return
            const intent = await begin(scopeID, retentionID, root)
            let published = false
            let unknown = false
            try {
              const writer = new Content.Writer(scopeID, retentionID, root, intent.contentID, "chunks-v2")
              for await (const ref of Content.references({ scopeID, retentionID, manifest: previous, signal })) {
                const bytes = await Storage.readBinary(ref.key, { maxBytes: ref.bytes })
                if (bytes.byteLength !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
                  throw new Error("Legacy Snapshot chunk verification failed before upgrade")
                await Storage.transaction(async (tx) => {
                  const location = await tx.artifact(ref.key)
                  if (!location || location.sha256 !== ref.sha256 || location.size !== ref.bytes)
                    throw new Error("Legacy Snapshot chunk changed during its native relink")
                  await tx.writeArtifacts([
                    {
                      key: Content.chunkKey(
                        scopeID,
                        retentionID,
                        { version: 2, root, contentID: intent.contentID, layout: "chunks-v2" },
                        ref,
                      ),
                      location,
                    },
                  ])
                })
                await writer.append({ pack: ref.pack, index: ref.index, bytes: ref.bytes, sha256: ref.sha256 })
              }
              const header = await writer.seal()
              signal?.throwIfAborted()
              published = await publish(intent, header, previous, signal)
            } catch (error) {
              unknown = error instanceof Storage.CommitUnknownError
              throw error
            } finally {
              if (!published && !unknown) await discard(intent)
            }
          },
        ),
      { signal },
    )
  }
}

export const storedSnapshotContentMigration: Migration = {
  id: "20261112-stored-snapshot-manifest-v2",
  scope: "global",
  execution: "maintenance",
  emptyInput: [["sessions"]],
  description: "Seal paged stored Snapshot descriptors while preserving legacy chunk references",
  async up(progress) {
    let count = 0
    const signal = UpgradeWork.signal()
    for await (const row of Storage.records({ prefix: ["sessions"], limit: 128 })) {
      signal?.throwIfAborted()
      if (row.key.length !== 6 || row.key[3] !== "snapshot_content" || row.key[5] !== "manifest") continue
      const manifest = Content.LegacyManifest.parse(row.value)
      if (manifest.root !== row.key[4]) throw new Error("Legacy Snapshot root identity changed")
      await StoredSnapshotMaintenance.upgrade(row.key[1], row.key[2], row.key[4], signal)
      progress(++count, 0)
    }
    signal?.throwIfAborted()
    progress(count, count)
  },
}
const migrations = [storedSnapshotContentMigration]
export function registerStoredSnapshotMigrations() {
  MigrationRegistry.register("stored-snapshot-content", migrations)
}
