import { SessionStaging } from "../session/staging"
import { Global } from "../global"
import { ensureMigrations } from "../migration"
import { ServerProcessLock } from "../util/server-process-lock"
import { Storage } from "./storage"
import { StorageBootstrap } from "./bootstrap"
import { StorageRecovery } from "./recovery"
import { StorageIntegrityError } from "./errors"

export namespace StorageMaintenance {
  export async function open(options: { readonly?: boolean; migrate?: boolean; recover?: boolean } = {}) {
    if (Storage.available()) throw new StorageIntegrityError("Maintenance cannot replace an installed Runtime Handle")
    if (options.readonly) {
      const handle = await StorageBootstrap.inspect(Global.Path.root)
      if (!handle)
        throw new StorageIntegrityError("Storage has not been initialized; run data storage resume before inspection")
      const uninstall = Storage.install(handle)
      const close = async () => {
        try {
          await handle.store.close()
        } finally {
          uninstall()
        }
      }
      return { ...handle, close, [Symbol.asyncDispose]: close }
    }
    const ownership = await ServerProcessLock.acquire(undefined, "oneshot")
    let prepared: StorageBootstrap.Prepared | undefined
    let uninstall: (() => void) | undefined
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        try {
          await prepared?.store.close()
        } finally {
          uninstall?.()
          await ownership.release()
        }
      })())
    try {
      await Global.initialize({ cache: false })
      if (options.recover) await StorageBootstrap.resumeTargetSwitch(Global.Path.root)
      prepared = await StorageBootstrap.prepare({ root: Global.Path.root, recover: options.recover })
      const handle = { store: prepared.store, artifactDirectory: Global.Path.data }
      uninstall = Storage.install(handle)
      await SessionStaging.recover()
      const pending = prepared
      const activate = async () => {
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
