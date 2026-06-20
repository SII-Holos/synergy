import z from "zod"
import { Global } from "@/global"
import path from "path"
import fs from "fs/promises"
import { Auth } from "@/provider/api-key"

export namespace HolosAccounts {
  export const AccountInfo = z.object({
    agentId: z.string(),
    agentSecret: z.string(),
    label: z.string().nullable(),
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
    try {
      const file = Bun.file(filepath())
      const data = await file.json()
      return Store.parse(data)
    } catch {
      return { activeAccountId: null, accounts: {} }
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
    await Bun.write(file, JSON.stringify(store, null, 2))
    await fs.chmod(file, 0o600)
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

  export async function saveAndActivateAccount(agentId: string, agentSecret: string, label?: string): Promise<void> {
    const store = await readStore()
    const now = Date.now()
    const existing = store.accounts[agentId]

    store.accounts[agentId] = {
      agentId,
      agentSecret,
      label: label ?? existing?.label ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    store.activeAccountId = agentId

    await writeStore(store)
  }

  export async function setActiveAccount(agentId: string): Promise<void> {
    const store = await readStore()
    if (!store.accounts[agentId]) {
      throw new Error(`Account not found: ${agentId}`)
    }
    store.activeAccountId = agentId
    await writeStore(store)
  }

  export async function deleteAccount(agentId: string): Promise<void> {
    const store = await readStore()
    delete store.accounts[agentId]
    if (store.activeAccountId === agentId) {
      store.activeAccountId = null
    }
    await writeStore(store)
  }

  export async function migrateFromLegacy(): Promise<{ migrated: boolean }> {
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
      label: existing?.label ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    store.activeAccountId = holos.agentId
    await writeStore(store)

    await Auth.remove("holos")

    return { migrated: true }
  }
}
