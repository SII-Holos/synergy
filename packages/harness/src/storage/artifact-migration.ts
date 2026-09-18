import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { ArtifactPack } from "./artifact-pack"
import type { ArtifactLocation } from "./artifact-location"
import { PackedBackup } from "./packed-backup"
import { syncRetiredDirectories, legacyBinaryKey, sourcePath } from "./legacy-source"
import type { TransactionalStore } from "./transactional-store"
import type { ImportProgress } from "./legacy-import"
import { NotFoundError, StorageConflictError, StorageIntegrityError } from "./errors"

const stateKey = ["storage_meta", "artifact-packs-v2"]
type State = { version: 2; phase: "backup" | "import" | "retire" | "complete"; cursor: number }
export namespace StorageArtifactMigration {
  export const id = "20260916-packed-artifacts-v2"
  export async function run(options: {
    dataRoot: string
    store: TransactionalStore
    progress?: (value: ImportProgress) => void
  }) {
    const { store, dataRoot, progress } = options
    const [previous, imported] = await store.readMany<State | { version: number }>([
      stateKey,
      ["storage_import", "info"],
    ])
    let state = previous as State | undefined
    if (state?.phase === "complete") return
    if (imported?.version === 2) {
      await store.write(stateKey, { version: 2, phase: "complete", cursor: 0 })
      return
    }
    state ??= { version: 2, phase: "backup", cursor: 0 }
    if (state.version !== 2) throw new StorageIntegrityError("Unsupported artifact migration version")
    const backupRoot = path.join(dataRoot, "storage", "backups", "artifacts-v2")
    const backup = new PackedBackup({
      dataRoot,
      backupRoot,
      selection: "artifacts",
      capacity: async (bytes) => {
        const disk = await fs.statfs(dataRoot, { bigint: true })
        if (disk.bavail * disk.bsize < BigInt(bytes + 32 * 1024 ** 2))
          throw new StorageIntegrityError("Insufficient free space for the next artifact backup checkpoint")
      },
      progress: (value) => progress?.({ stage: "backup", current: value.files, total: 0, bytes: value.bytes }),
    })
    const pack = new ArtifactPack(path.join(dataRoot, "agent-artifacts"))
    if (state.phase === "backup" || state.phase === "import") {
      progress?.({ stage: "backup", current: 0, total: 0, bytes: 0 })
      await backup.create()
      if (state.phase === "backup") {
        state = { version: 2, phase: "import", cursor: 0 }
        await store.write(stateKey, state)
      }
      let position = 0
      let group = -1,
        packName = ""
      let batch: Array<{ key: string[]; location: ArtifactLocation }> = []
      const flush = async () => {
        if (!batch.length) return
        const pending = batch
        const next: State = { version: 2, phase: "import", cursor: position }
        await store.transaction(async (tx) => {
          const writes: typeof pending = []
          for (const entry of pending) {
            try {
              const existing = await tx.artifact(entry.key)
              if (existing.sha256 !== entry.location.sha256 || existing.size !== entry.location.size)
                throw new StorageIntegrityError("Legacy binary content conflicts with authoritative data")
              continue
            } catch (error) {
              if (!(error instanceof NotFoundError)) throw error
            }
            if (entry.key[0] === "sessions") {
              try {
                await tx.assertNotDeleted([...entry.key.slice(0, 3), "info"])
              } catch (error) {
                if (error instanceof StorageConflictError) continue
                throw error
              }
            }
            writes.push(entry)
          }
          await tx.writeArtifacts(writes)
          await tx.write(stateKey, next)
        })
        state = next
        batch = []
        progress?.({ stage: "import", current: position, total: 0, bytes: 0 })
      }
      progress?.({ stage: "import", current: state.cursor, total: 0, bytes: 0 })
      for await (const entry of backup.entries()) {
        position++
        if (position <= state.cursor) continue
        const key = legacyBinaryKey(entry.relative)
        if (!key) throw new StorageIntegrityError("Artifact migration inventory contains another file type")
        if (group !== entry.group) {
          packName = await pack.adopt(entry.packed)
          group = entry.group
        }
        batch.push({
          key,
          location: {
            pack: packName,
            blockOffset: entry.packed.blockOffset,
            blockBytes: entry.packed.storedBytes,
            decodedBytes: entry.packed.decodedBytes,
            offset: entry.packed.offset,
            size: entry.size,
            codec: entry.packed.codec,
            sha256: entry.hash,
          },
        })
        if (batch.length === 256) await flush()
      }
      await flush()
      state = { version: 2, phase: "retire", cursor: 0 }
      await store.write(stateKey, state)
    }
    let position = 0
    let committed = state.cursor
    const directories = new Set<string>()
    const checkpoint = async () => {
      await syncRetiredDirectories(dataRoot, directories)
      directories.clear()
      await store.write(stateKey, { version: 2, phase: "retire", cursor: position })
      committed = position
      progress?.({ stage: "activate", current: position, total: 0, bytes: 0 })
    }
    progress?.({ stage: "activate", current: committed, total: 0, bytes: 0 })
    for await (const entry of backup.entries()) {
      position++
      if (position <= committed) continue
      const key = legacyBinaryKey(entry.relative)!
      const location = await store
        .snapshot((tx) => tx.artifact(key))
        .catch((error: unknown) => {
          if (error instanceof NotFoundError) return undefined
          throw error
        })
      if (location) {
        if (location.sha256 !== entry.hash)
          throw new StorageIntegrityError("Artifact authority changed during migration")
        await pack.verify(location)
      } else {
        let deleted = false
        if (key[0] === "sessions")
          await store
            .snapshot((tx) => tx.assertNotDeleted([...key.slice(0, 3), "info"]))
            .catch((error: unknown) => {
              if (!(error instanceof StorageConflictError)) throw error
              deleted = true
            })
        if (!deleted) throw new StorageIntegrityError("Cannot retire an unaccounted binary artifact")
      }
      const filename = sourcePath(dataRoot, entry.relative)
      try {
        const digest = createHash("sha256")
        for await (const bytes of createReadStream(filename)) digest.update(bytes)
        if (digest.digest("hex") !== entry.hash)
          throw new StorageIntegrityError("A legacy writer changed binary data during activation")
        await fs.unlink(filename)
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      }
      directories.add(path.dirname(filename))
      if (position - committed >= 256) await checkpoint()
    }
    if (position !== committed) await checkpoint()
    await store.write(stateKey, { version: 2, phase: "complete", cursor: position })
  }
}
