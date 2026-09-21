import { RuntimeContext } from "../lifecycle/context"
import fs from "node:fs/promises"
import path from "node:path"
import { PackedBackup } from "./packed-backup"
import { SegmentedBackup } from "./segmented-backup"
import { SessionStaging } from "../session/staging"
import { SessionCompat } from "../session/compat-import"
import { Global } from "../global"
import { ensureMigrations } from "../migration"
import { ServerProcessLock } from "../util/server-process-lock"
import { Storage } from "./storage"
import { StorageBootstrap } from "./bootstrap"
import { StorageRecovery } from "./recovery"
import { StorageIntegrityError } from "./errors"
import { StorageReclamation } from "./format-reclamation"
import { observeStorageMaintenance } from "./maintenance-progress"
import { UpgradeWork } from "./upgrade-work"
import type { StorageMaintenanceEvent } from "@ericsanchezok/synergy-util/runtime-startup"

export namespace StorageMaintenance {
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
  export const Status = StorageReclamation.Status
  export const status = () => StorageReclamation.status(Storage.current().store)
  export const controlReclaim = (action: "pause" | "resume") =>
    StorageReclamation.control(Storage.current().store, action)
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
      const handle = { store: prepared.store, artifactDirectory: Global.Path.data }
      runtime.storage = handle
      await SessionStaging.recover()
      const pending = prepared
      const activate = async () => {
        await SessionCompat.prepareRecovery()
        if (pending.manifest.phase !== "active") await StorageRecovery.validate()
        await pending.activate()
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
