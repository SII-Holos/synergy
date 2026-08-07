import {
  authLockDirectory,
  HOLOS_ACCOUNTS_WRITE_LOCK_KEY,
  LEGACY_API_KEY_WRITE_LOCK_KEY,
  withFileLock,
} from "@ericsanchezok/synergy-util/fs-lock"
import z from "zod"
import { Global } from "@/global"
import path from "path"
import fs from "fs/promises"
import { Auth } from "@/provider/api-key"
import { readFileWithRetry } from "@/util/io-retry"

export namespace HolosAccounts {
  export class MalformedStoreError extends Error {
    constructor(cause: unknown) {
      super("Failed to parse the shared Holos account store.", { cause })
      this.name = "HolosAccountsMalformedStoreError"
    }
  }
  export const AccountInfo = z.object({
    agentId: z.string(),
    agentSecret: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type AccountInfo = z.infer<typeof AccountInfo>

  const Store = z.object({
    activeAccountId: z.string().nullable(),
    accounts: z.record(z.string(), AccountInfo),
  })
  type Store = z.infer<typeof Store>

  function filepath() {
    return Global.Path.authHolosAccounts
  }

  async function readStore(): Promise<Store> {
    let raw: string
    try {
      raw = await readFileWithRetry(filepath())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { activeAccountId: null, accounts: {} }
      }
      throw error
    }

    try {
      return Store.parse(JSON.parse(raw))
    } catch (error) {
      throw new MalformedStoreError(error)
    }
  }

  async function writeStore(store: Store): Promise<void> {
    const file = filepath()
    const parent = path.dirname(file)
    try {
      await fs.mkdir(parent, { recursive: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unable to create data directory at ${parent}: ENOENT: no such file or directory`)
      }
      throw err
    }

    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      await fs.rename(temporary, file)
      await fs.chmod(file, 0o600)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async function removeLegacyHolosEntry(): Promise<void> {
    await withFileLock(
      {
        directory: authLockDirectory(Global.Path.root),
        key: LEGACY_API_KEY_WRITE_LOCK_KEY,
        timeoutMessage: "Timed out acquiring legacy credential lock",
      },
      async () => {
        const file = Auth.legacyFilepath()
        const data = await Bun.file(file)
          .json()
          .catch(() => undefined)
        if (!data || typeof data !== "object" || Array.isArray(data) || !("holos" in data)) return

        delete (data as Record<string, unknown>)["holos"]
        const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
        await fs.mkdir(path.dirname(file), { recursive: true })
        try {
          await fs.writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 })
          await fs.rename(temporary, file)
          await fs.chmod(file, 0o600)
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => {})
          throw error
        }
      },
    )
  }

  export async function getActiveAccount(): Promise<AccountInfo | undefined> {
    const store = await readStore()
    if (!store.activeAccountId) return undefined
    return store.accounts[store.activeAccountId]
  }

  export async function listAccounts(): Promise<AccountInfo[]> {
    const store = await readStore()
    return Object.values(store.accounts)
  }

  export async function getAccount(agentId: string): Promise<AccountInfo | undefined> {
    const store = await readStore()
    return store.accounts[agentId]
  }

  export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const directory = authLockDirectory(Global.Path.root)
    try {
      return await withFileLock(
        {
          directory,
          key: HOLOS_ACCOUNTS_WRITE_LOCK_KEY,
          timeoutMessage: "Timed out acquiring Holos accounts lock",
        },
        fn,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unable to create data directory at ${directory}: ENOENT: no such file or directory`)
      }
      throw error
    }
  }

  export async function saveAndActivateAccount(agentId: string, agentSecret: string): Promise<void> {
    await withWriteLock(async () => {
      const store = await readStore()
      const now = Date.now()
      const existing = store.accounts[agentId]

      store.accounts[agentId] = {
        agentId,
        agentSecret,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      store.activeAccountId = agentId

      await writeStore(store)
    })
  }

  export async function setActiveAccount(agentId: string): Promise<void> {
    await withWriteLock(async () => {
      const store = await readStore()
      if (!store.accounts[agentId]) {
        throw new Error(`Account not found: ${agentId}`)
      }
      store.activeAccountId = agentId
      await writeStore(store)
    })
  }

  export async function deleteAccount(agentId: string): Promise<void> {
    await withWriteLock(async () => {
      const store = await readStore()
      delete store.accounts[agentId]
      if (store.activeAccountId === agentId) {
        store.activeAccountId = null
      }
      await writeStore(store)
    })
    await removeLegacyHolosEntry()
  }

  export async function migrateFromLegacy(): Promise<{ migrated: boolean }> {
    return await withWriteLock(async () => {
      await Auth.migrateLegacy({ backup: false })
      const authData = await Auth.all()
      const holos = authData["holos"]
      if (!holos || holos.type !== "holos") {
        return { migrated: false }
      }

      const store = await readStore()
      const now = Date.now()
      const existing = store.accounts[holos.agentId]

      store.accounts[holos.agentId] = {
        agentId: holos.agentId,
        agentSecret: holos.agentSecret,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      store.activeAccountId = holos.agentId
      await writeStore(store)

      await Auth.remove("holos")
      await removeLegacyHolosEntry()

      return { migrated: true }
    })
  }
}
