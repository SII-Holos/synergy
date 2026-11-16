import { z } from "zod"
import {
  OrganizationClientAuth as Auth,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { spaceKey } from "@/context/space-state"

export const OrganizationSignOutIntent = Auth.Authority.extend({
  version: z.literal(1),
  connectionKey: z.string().min(1).max(8192),
  connectionID: Identity.Token,
  clientID: Identity.ID,
  accountID: Identity.ID,
  expectedRevision: z.uuid(),
  requestID: z.uuid(),
})
  .strict()
  .refine(
    (value) =>
      value.connectionKey ===
      spaceKey({
        kind: "organization",
        orgID: value.orgID,
        accountID: value.accountID,
        deploymentIncarnation: value.deploymentIncarnation,
      }),
    "Sign-out intent belongs to another space",
  )
export type OrganizationSignOutIntent = z.infer<typeof OrganizationSignOutIntent>
export interface OrganizationSignOutStore {
  get(connectionKey: string): Promise<OrganizationSignOutIntent | undefined>
  begin(intent: OrganizationSignOutIntent): Promise<OrganizationSignOutIntent>
  remove(intent: OrganizationSignOutIntent): Promise<boolean>
  close(): void
}
const databaseName = "synergy.organization-connections"
function request<T>(value: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error("Connection intent could not be read"))
  })
}
export function createOrganizationSignOutStore(
  input: { factory?: IDBFactory; name?: string } = {},
): OrganizationSignOutStore {
  let closed = false
  let database: IDBDatabase | undefined
  let opening: Promise<IDBDatabase> | undefined
  const transactions = new Set<IDBTransaction>()
  function current() {
    if (closed) throw new Error("Connection intent store has closed")
  }
  function open() {
    current()
    return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = input.factory ?? globalThis.indexedDB
      if (!factory) {
        reject(new Error("Persistent connection storage is unavailable"))
        return
      }
      const opening = factory.open(input.name ?? databaseName, 1)
      let rejected = false
      opening.onupgradeneeded = () => opening.result.createObjectStore("sign-outs", { keyPath: "connectionKey" })
      opening.onblocked = () => {
        rejected = true
        reject(new Error("Another page holds an older connection store"))
      }
      opening.onerror = () => {
        rejected = true
        reject(opening.error ?? new Error("Connection intent could not be opened"))
      }
      opening.onsuccess = () => {
        if (closed || rejected) {
          opening.result.close()
          reject(new Error("Connection intent store has closed"))
          return
        }
        database = opening.result
        database.onversionchange = close
        resolve(database)
      }
    }).catch((error: unknown) => {
      opening = undefined
      throw error
    }))
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await open()
    current()
    const work = db.transaction("sign-outs", mode)
    transactions.add(work)
    const done = new Promise<void>((resolve, reject) => {
      work.oncomplete = () => resolve()
      work.onabort = work.onerror = () => reject(work.error ?? new Error("Connection intent transaction failed"))
    })
    void done.catch(() => {})
    try {
      const result = await operation(work.objectStore("sign-outs"))
      await done
      current()
      return result
    } catch (error) {
      try {
        work.abort()
      } catch {}
      await done.catch(() => {})
      throw error
    } finally {
      transactions.delete(work)
    }
  }
  function parse(value: unknown, key: string) {
    if (value === undefined) return
    const intent = OrganizationSignOutIntent.parse(value)
    if (intent.connectionKey !== key) throw new Error("Connection intent belongs to another space")
    return intent
  }
  function close() {
    closed = true
    for (const work of transactions) {
      try {
        work.abort()
      } catch {}
    }
    database?.close()
  }
  return {
    get(key) {
      return transaction("readonly", async (store) => parse(await request(store.get(key)), key))
    },
    begin(value) {
      const intent = OrganizationSignOutIntent.parse(value)
      return transaction("readwrite", async (store) => {
        const previous = parse(await request(store.get(intent.connectionKey)), intent.connectionKey)
        if (previous) return previous
        await request(store.add(intent))
        return intent
      })
    },
    remove(value) {
      const intent = OrganizationSignOutIntent.parse(value)
      return transaction("readwrite", async (store) => {
        const previous = parse(await request(store.get(intent.connectionKey)), intent.connectionKey)
        if (!previous || JSON.stringify(previous) !== JSON.stringify(intent)) return false
        await request(store.delete(intent.connectionKey))
        return true
      })
    },
    close,
  }
}
