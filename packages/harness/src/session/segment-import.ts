import { z } from "zod"
import { work } from "../util/queue"
import fs from "node:fs/promises"
import path from "node:path"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { Storage } from "../storage/storage"
import { StorageCompat } from "../storage/compat"
import { StorageIntegrityError } from "../storage/errors"
import { ArtifactPack } from "../storage/artifact-pack"
import type { ArtifactLocation } from "../storage/artifact-location"
import { SegmentedBackup } from "../storage/segmented-backup"
import type { PackedBackupEntry } from "../storage/packed-backup"
import {
  legacyBinaryKey,
  legacyFiles,
  legacyRecordKey,
  sourcePath,
  syncRetiredDirectories,
} from "../storage/legacy-source"
import { validateLegacyRecord } from "../storage/legacy-record"
import { verifyRetirement } from "../storage/file-digest"
import { UpgradeWork } from "../storage/upgrade-work"

const cleanupRoot = ["compat_cleanup"]
type Hooks = {
  validate(value: unknown): Promise<unknown>
  quarantine(locator: StorageCompat.Locator, relative: string, reason: string): Promise<StorageCompat.Locator>
  indexes(owner: { scopeID: string; sessionID: string }): Promise<void>
}

export namespace SessionSegment {
  export async function importOwner(
    initial: StorageCompat.Locator,
    backup: SegmentedBackup,
    stageOnly: boolean,
    hooks: Hooks,
  ) {
    let locator = initial
    const store = Storage.current().store
    const prefix = `sessions/${locator.scopeID}/${locator.sessionID}/`
    const owner = { scopeID: locator.scopeID, sessionID: locator.sessionID }
    const update = async (phase: StorageCompat.Locator["phase"]) => {
      locator = { ...locator, phase }
      await StorageCompat.writeLocator(store, locator)
      await UpgradeWork.checkpoint()
    }
    await UpgradeWork.checkpoint()
    await update("backup")
    const sealed = await backup.sealSession(owner)
    const pack = new ArtifactPack(path.join(Storage.current().artifactDirectory, "agent-artifacts"))
    const lock = {
      directory: path.join(Storage.current().artifactDirectory, "storage", ".locks"),
      key: "artifact-packs",
    }
    const adopted = new Set<string>()
    const pin = (name: string) => ["storage_pack_pins", name, locator.sessionID]
    let batch: PackedBackupEntry[] = []
    let bytes = 0
    let rowLimit = 128
    let failure: StorageCompat.Locator | undefined
    const flush = async () => {
      if (!batch.length) return
      await UpgradeWork.checkpoint(bytes)
      const entries = batch
      batch = []
      bytes = 0
      const keys = entries.map((entry) => StorageCompat.fileCheckpointKey(locator.sessionID, entry.relative))
      const previous = await store.readMany<string>(keys)
      const writes: Array<{ key: string[]; value: unknown }> = []
      const artifacts: Array<{ key: string[]; location: ArtifactLocation }> = []
      const pins: string[][] = []
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        if (previous[index] !== undefined) {
          if (previous[index] !== entry.hash)
            throw new StorageIntegrityError("Deferred checkpoint differs from its sealed backup")
          continue
        }
        if (locator.retiring) throw new StorageIntegrityError("Retiring Session has an incomplete import checkpoint")
        if (entry.linkTarget !== undefined)
          throw new StorageIntegrityError("Authoritative deferred records cannot be symbolic links")
        const key = legacyRecordKey(entry.relative)
        if (key) {
          if (entry.size > 128 * 1024 ** 2) {
            failure = await hooks.quarantine(
              locator,
              entry.relative,
              "Historical record exceeds the automatic preparation size limit",
            )
            return
          }
          let value: unknown
          try {
            value = JSON.parse(entry.data?.toString("utf8") ?? (await fs.readFile(entry.filename!, "utf8")))
            validateLegacyRecord(key, value)
          } catch (error) {
            if (!(error instanceof SyntaxError || error instanceof StorageIntegrityError)) throw error
            failure = await hooks.quarantine(locator, entry.relative, error.message)
            return
          }
          writes.push({ key, value })
        } else {
          const name = entry.packed.sha256 + ".pack"
          const key = pin(name)
          await withFileLock(lock, () => store.write(key, { backupID: backup.backupID }))
          if (!adopted.has(name)) {
            await pack.adopt(entry.packed, UpgradeWork.signal())
            adopted.add(name)
            if (adopted.size > 8) adopted.delete(adopted.values().next().value!)
          }
          pins.push(key)
          artifacts.push({
            key: legacyBinaryKey(entry.relative)!,
            location: {
              pack: name,
              blockOffset: entry.packed.blockOffset,
              blockBytes: entry.packed.storedBytes,
              decodedBytes: entry.packed.decodedBytes,
              offset: entry.packed.offset,
              size: entry.size,
              codec: entry.packed.codec,
              sha256: entry.hash,
            },
          })
        }
        writes.push({ key: keys[index], value: entry.hash })
      }
      const next = {
        ...locator,
        status: "partial" as const,
        phase: "import" as const,
        files: (locator.files ?? 0) + entries.filter((_, i) => previous[i] === undefined).length,
        bytes:
          (locator.bytes ?? 0) +
          entries.reduce((sum, entry, i) => sum + (previous[i] === undefined ? entry.size : 0), 0),
      }
      const start = performance.now()
      await store.transaction(async (tx) => {
        await tx.writeMany(writes)
        await tx.writeArtifacts(artifacts)
        await StorageCompat.setLocator(tx, next)
        for (const key of pins) await tx.remove(key)
      })
      const elapsed = performance.now() - start
      if (elapsed > 100) rowLimit = Math.max(1, Math.floor(rowLimit / 2))
      else if (elapsed < 25) rowLimit = Math.min(128, rowLimit + 8)
      locator = next
    }
    let hasInfo = false
    await update("import")
    for await (const entry of sealed.entries((relative) => Boolean(legacyRecordKey(relative)))) {
      if (!entry.relative.startsWith(prefix)) throw new StorageIntegrityError("Backup entry escaped its Session owner")
      if (entry.relative === prefix + "info.json") hasInfo = true
      if (!legacyRecordKey(entry.relative) && !legacyBinaryKey(entry.relative)) continue
      const size = Buffer.byteLength(JSON.stringify(entry.relative)) + (entry.data?.byteLength ?? entry.size) * 2 + 1024
      if (batch.length && bytes + size > 4 * 1024 ** 2) await flush()
      if (failure) return failure
      batch.push(entry)
      bytes += size
      if (batch.length >= rowLimit) await flush()
      if (failure) return failure
    }
    await flush()
    if (failure) return failure
    if (!hasInfo) return hooks.quarantine(locator, prefix + "info.json", "Missing legacy Session metadata")
    locator = { ...locator, status: "partial", staged: true }
    await StorageCompat.writeLocator(store, locator)
    if (stageOnly) return locator
    await update("migrate")
    const { migrateDeferredSession } = await import("../migration")
    await migrateDeferredSession(owner, "canonical")
    const { RolloutRecovery } = await import("./rollout/recovery")
    await RolloutRecovery.owner({ kind: "session", ...owner }, () => UpgradeWork.signal()?.throwIfAborted())
    try {
      await hooks.validate(await store.read(["sessions", owner.scopeID, owner.sessionID, "info"]))
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      return hooks.quarantine(locator, prefix + "info.json", "Session metadata does not match the current schema")
    }
    const { SnapshotProtection } = await import("./snapshot-protection")
    if (await SnapshotProtection.active(Storage.current().artifactDirectory)) {
      const { SnapshotMaintenance } = await import("./snapshot-maintenance")
      const result = await SnapshotMaintenance.migrate(owner.scopeID, {
        apply: true,
        sessionID: owner.sessionID,
        signal: UpgradeWork.signal(),
      })
      if (result.results.some((entry) => entry.status !== "migrated"))
        throw new StorageIntegrityError("Historical snapshot preparation failed; original objects remain protected")
    }
    await update("verify")
    let verification: PackedBackupEntry[] = []
    const verify = async () => {
      await work(4, verification, async (entry) => {
        await UpgradeWork.checkpoint()
        await verifyRetirement(
          sourcePath(backup.sourceRoot, entry.relative),
          entry.hash,
          entry.size,
          "Deferred legacy data changed during its import",
          { tolerateMissing: locator.retiring },
        )
        const binary = legacyBinaryKey(entry.relative)
        if (binary) await pack.verify(await store.snapshot((tx) => tx.artifact(binary)), UpgradeWork.signal())
      })
      verification = []
    }
    for await (const entry of sealed.entries(() => false)) {
      if (!legacyRecordKey(entry.relative) && !legacyBinaryKey(entry.relative)) continue
      verification.push(entry)
      if (verification.length >= 64) await verify()
    }
    await verify()
    try {
      let files: string[][] = []
      const verify = async () => {
        if (!files.length) return
        await UpgradeWork.checkpoint()
        if ((await store.readMany(files)).some((checkpoint) => !checkpoint))
          throw new StorageIntegrityError("New legacy data appeared after the backup was sealed")
        files = []
      }
      for await (const file of legacyFiles(sourcePath(backup.sourceRoot, prefix.slice(0, -1)))) {
        const relative = prefix + file.relative
        if (!legacyRecordKey(relative) && !legacyBinaryKey(relative)) continue
        files.push(StorageCompat.fileCheckpointKey(owner.sessionID, relative))
        if (files.length >= 128) await verify()
      }
      await verify()
    } catch (error) {
      if (!(locator.retiring && error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error
    }
    await update("publish")
    const imported: StorageCompat.Locator = {
      ...owner,
      activity: locator.activity,
      status: "imported",
      phase: "complete",
      files: locator.files,
      bytes: locator.bytes,
    }
    await Storage.transaction(async (tx) => {
      await migrateDeferredSession(owner, "derived")
      await hooks.indexes(owner)
      await StorageCompat.setLocator(tx, imported)
      await tx.write([...cleanupRoot, owner.sessionID], { ...owner, backupID: backup.backupID })
    })
    const { completeDeferredMigrations } = await import("../migration")
    await completeDeferredMigrations()
    return imported
  }

  export async function cleanup() {
    const rows = await Storage.query<{ scopeID: string; sessionID: string; backupID: string }>({
      kind: cleanupRoot[0],
      limit: 1,
    })
    for (const { key, value: owner } of rows) {
      const backup = new SegmentedBackup(Storage.current().artifactDirectory, owner.backupID)
      const sealed = await backup.sealSession(owner)
      let retired: PackedBackupEntry[] = []
      const flush = async () => {
        if (!retired.length) return
        await work(4, retired, async (entry) => {
          await UpgradeWork.checkpoint()
          const filename = sourcePath(backup.sourceRoot, entry.relative)
          await verifyRetirement(filename, entry.hash, entry.size, "Legacy data changed before cleanup", {
            tolerateMissing: true,
          })
          await fs.rm(filename, { force: true })
        })
        await syncRetiredDirectories(backup.sourceRoot, [
          ...new Set(retired.map((entry) => path.dirname(sourcePath(backup.sourceRoot, entry.relative)))),
        ])
        await Storage.transaction((tx) =>
          tx.removeMany(retired.map((entry) => StorageCompat.fileCheckpointKey(owner.sessionID, entry.relative))),
        )
        retired = []
      }
      for await (const entry of sealed.entries(() => false)) {
        if (!legacyRecordKey(entry.relative) && !legacyBinaryKey(entry.relative)) continue
        retired.push(entry)
        if (retired.length >= 64) await flush()
      }
      await flush()
      await Storage.remove(key)
    }
    return rows.length
  }
}
