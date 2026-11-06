import { RuntimeContext } from "../lifecycle/context"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { PackedBackup } from "./packed-backup"
import { SegmentedBackup } from "./segmented-backup"
import { SessionStaging } from "../session/staging"
import { SessionCompat } from "../session/compat-import"
import { Global } from "../global"
import { ensureMigrations, runMigrations } from "../migration"
import { ServerProcessLock } from "../util/server-process-lock"
import { Storage } from "./storage"
import { StorageBootstrap } from "./bootstrap"
import { StorageRecovery } from "./recovery"
import { StorageIntegrityError } from "./errors"
import { StorageReclamation } from "./format-reclamation"
import { observeStorageMaintenance } from "./maintenance-progress"
import { UpgradeWork } from "./upgrade-work"
import type { StorageMaintenanceEvent } from "@ericsanchezok/synergy-util/runtime-startup"
import { z } from "zod"
import { StorageRetention } from "./retention"
import { ObservabilityConfig } from "../observability/config"
import { Config } from "../config/config"
import { RolloutJournalMaintenance } from "../session/rollout/journal-maintenance"
import { StoragePortable } from "./portable"

const exclusive = new WeakSet<object>()

export namespace StorageMaintenance {
  function assertExclusive() {
    if (!exclusive.has(Storage.current().store))
      throw new StorageIntegrityError("Rollout compaction requires an exclusive maintenance window")
  }
  export const rolloutStatus = () => RolloutJournalMaintenance.status()
  export async function prepareRolloutBackup() {
    assertExclusive()
    const store = Storage.current().store
    const directory = path.join(Storage.current().artifactDirectory, "storage", "backups")
    const state = await RolloutJournalMaintenance.status()
    if (state.backup) {
      const filename = path.join(directory, state.backup.file)
      if (
        path.basename(state.backup.file) !== state.backup.file ||
        (await fs.stat(filename)).size !== state.backup.bytes
      )
        throw new StorageIntegrityError("Rollout maintenance backup is missing or changed")
      const hash = createHash("sha256")
      for await (const bytes of Bun.file(filename).stream()) {
        UpgradeWork.signal()?.throwIfAborted()
        hash.update(bytes)
      }
      if (hash.digest("hex") !== state.backup.sha256)
        throw new StorageIntegrityError("Rollout maintenance backup checksum mismatch")
      return
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const capacity = await fs.statfs(directory)
    const estimate = store.sqliteFilename
      ? (await fs.stat(store.sqliteFilename)).size +
        (await fs.stat(store.sqliteFilename + "-wal").catch(() => ({ size: 0 }))).size
      : Number(
          (
            await store.snapshot((tx) =>
              tx.raw.query<{ bytes: number }>("SELECT pg_database_size(current_database()) AS bytes"),
            )
          )[0].bytes,
        ) * 2
    if (capacity.bavail * capacity.bsize < estimate + 1024 ** 3)
      throw new StorageIntegrityError("Insufficient free space for the Rollout backup and maintenance reserve")
    const file = `rollout-${crypto.randomUUID()}.${store.sqliteFilename ? "sqlite" : "ndjson"}`
    const temporary = path.join(directory, file + ".partial")
    try {
      UpgradeWork.signal()?.throwIfAborted()
      if (store.sqliteFilename) await store.backupSqlite(temporary)
      else await StoragePortable.exportFile(store, temporary)
      const handle = await fs.open(temporary, "r+")
      try {
        await handle.chmod(0o600)
        await handle.sync()
      } finally {
        await handle.close()
      }
      const hash = createHash("sha256")
      for await (const bytes of Bun.file(temporary).stream()) {
        UpgradeWork.signal()?.throwIfAborted()
        hash.update(bytes)
      }
      const bytes = (await fs.stat(temporary)).size
      await fs.rename(temporary, path.join(directory, file))
      if (process.platform !== "win32") {
        const parent = await fs.open(directory, "r")
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      }
      await RolloutJournalMaintenance.backup({ file, bytes, sha256: hash.digest("hex") })
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }
  export async function compactRollout(options: { apply?: boolean; signal?: AbortSignal } = {}) {
    assertExclusive()
    return Storage.withMigrationRecords(() =>
      UpgradeWork.run({ background: false, signal: options.signal }, async () => {
        if (!options.apply) return RolloutJournalMaintenance.inspect(options.signal)
        const result = await runMigrations({
          targetDomain: "rollout-journal",
          maintenance: true,
          output: "silent",
          signal: options.signal,
        })
        if (result.failed)
          throw new StorageIntegrityError("Rollout compaction failed; its last committed batch is resumable")
        const status = await rolloutStatus()
        if (status.phase !== "completed") throw new StorageIntegrityError("Rollout compaction migration is unavailable")
        return status
      }),
    )
  }
  export function observe<T>(
    operation: () => Promise<T>,
    reporter: (event: StorageMaintenanceEvent) => void,
    signal?: AbortSignal,
  ) {
    return UpgradeWork.run({ background: false, signal }, () => {
      signal?.throwIfAborted()
      return observeStorageMaintenance(operation, reporter)
    })
  }
  export const Status = StorageReclamation.Status.extend({
    prune: z.object({ owners: z.number().int().nonnegative(), updatedAt: z.number() }),
  }).meta({ ref: "StorageMaintenanceStatus" })
  export const status = async () => ({
    ...(await StorageReclamation.status(Storage.current().store)),
    prune: await StorageRetention.deferred(),
  })
  export async function prune(signal?: AbortSignal) {
    if (!exclusive.has(Storage.current().store))
      throw new StorageIntegrityError("Pruning requires an exclusive maintenance window")
    ObservabilityConfig.refresh(await Config.globalResolved())
    const config = ObservabilityConfig.current().storage
    return StorageRetention.run({
      retentionMs: config.retentionMs,
      maxBytes: config.retentionBytes,
      liveSessionIDs: [],
      maintenance: true,
      signal,
    })
  }
  export const controlReclaim = async (action: "pause" | "resume") => {
    await StorageReclamation.control(Storage.current().store, action)
    return status()
  }
  export const reclaim = (
    options: { signal?: AbortSignal; progress?: (current: number, total: number, phase: number) => void } = {},
  ) => StorageReclamation.drain(Storage.current().store, options)
  export async function restoreBackup(backupRoot: string, destination: string) {
    const target = path.resolve(destination)
    const parent = path.dirname(target)
    await fs.mkdir(parent, { recursive: true, mode: 0o700 })
    try {
      await fs.mkdir(target, { mode: 0o700 })
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
        throw new StorageIntegrityError("Backup restore destination already exists")
      throw error
    }
    let temporary: string | undefined
    try {
      temporary = await fs.mkdtemp(path.join(parent, ".synergy-restore-"))
      const backup = new PackedBackup({ dataRoot: path.join(temporary, "data"), backupRoot: path.resolve(backupRoot) })
      let manifest: { files: number; bytes: number }
      if (await Bun.file(path.join(backupRoot, "segmented.json")).exists()) {
        const segmented = await SegmentedBackup.open(backupRoot)
        manifest = await segmented.restore(path.join(temporary, "data"))
      } else {
        const sealed = await backup.manifest()
        if (!sealed || sealed.selection !== "home" || sealed.excludedRoots?.length)
          throw new StorageIntegrityError("Restore requires a sealed Home backup or a recoverable segmented backup")
        await backup.restore(path.join(temporary, "data"))
        manifest = sealed
      }
      if (process.platform !== "win32") {
        const directory = await fs.open(temporary, "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
      await fs.rmdir(target)
      await fs.rename(temporary, target)
      if (process.platform !== "win32") {
        const directory = await fs.open(parent, "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
      return { status: "restored", files: manifest.files, bytes: manifest.bytes, destination: target }
    } catch (error) {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true })
      await fs.rmdir(target).catch(() => {})
      throw error
    }
  }

  export async function open(options: { readonly?: boolean; migrate?: boolean; recover?: boolean } = {}) {
    const runtime = RuntimeContext.current()
    if (Storage.available())
      throw new StorageIntegrityError("Maintenance cannot replace an attached Runtime storage Handle")
    if (options.readonly) {
      const handle = await StorageBootstrap.inspect(Global.Path.root)
      if (!handle)
        throw new StorageIntegrityError("Storage has not been initialized; run data storage resume before inspection")
      runtime.storage = handle
      const close = async () => {
        try {
          await handle.store.close()
        } finally {
          runtime.storage = undefined
        }
      }
      return { ...handle, close, [Symbol.asyncDispose]: close }
    }
    const ownership = await ServerProcessLock.acquire(undefined, "oneshot")
    let prepared: StorageBootstrap.Prepared | undefined
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        try {
          await prepared?.store.close()
        } finally {
          runtime.storage = undefined
          await ownership.release()
        }
      })())
    try {
      await Global.initialize({ cache: false })
      if (options.recover) await StorageBootstrap.resumeTargetSwitch(Global.Path.root)
      prepared = await StorageBootstrap.prepare({ root: Global.Path.root, recover: options.recover })
      exclusive.add(prepared.store)
      const handle = { store: prepared.store, artifactDirectory: Global.Path.data }
      runtime.storage = handle
      await SessionStaging.recover()
      const pending = prepared
      const activate = async () => {
        await SessionCompat.prepareRecovery()
        if (pending.manifest.phase !== "active") await StorageRecovery.validate()
        await pending.activate()
        if (options.recover) await Storage.collectArtifactGarbage({ scanOrphans: true })
        await StorageRecovery.recoverOwners()
      }
      if (options.migrate !== false) {
        await ensureMigrations({ output: "silent" })
        await activate()
      }
      return { ...handle, manifest: prepared.manifest, activate, close, [Symbol.asyncDispose]: close }
    } catch (error) {
      await close()
      throw error
    }
  }
}
