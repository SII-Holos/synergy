import { z } from "zod"
import type { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { spaceKey } from "@/context/space-state"
import {
  PublicationIdentity,
  PublicationRecord,
  publicationAttempt,
  publicationFailed,
  publicationConfirmed,
  publicationScopeKey,
} from "./publication-record"

const databaseName = "synergy.organization-publications"
const tableName = "requests"
function initialize(database: IDBDatabase) {
  const table = database.createObjectStore(tableName, { keyPath: ["connectionKey", "request.requestID"] })
  table.createIndex("scope", ["connectionKey", "purpose", "scopeKey", "createdAt", "request.requestID"])
  table.createIndex("connection", "connectionKey")
}
const changes = new Set<{ key: string; notify: () => void }>()
const Cursor = z.strictObject({
  key: z.string(),
  purpose: z.enum(["knowledge", "artifact"]),
  scope: z.string(),
  createdAt: z.number().int().nonnegative().safe(),
  requestID: z.string().min(1),
})
function read<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Publication recovery metadata could not be read"))
  })
}
function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("Publication recovery metadata was not saved"))
    transaction.onerror = () => reject(transaction.error ?? new Error("Publication recovery metadata was not saved"))
  })
}
export function observePublicationMetadata(identity: PublicationIdentity, notify: () => void) {
  const entry = { key: spaceKey(identity), notify }
  changes.add(entry)
  return () => {
    changes.delete(entry)
  }
}
export function createOrganizationPublicationStore(input: {
  identity: PublicationIdentity
  signal?: AbortSignal
  factory?: IDBFactory
  name?: string
}) {
  const identity = PublicationIdentity.parse(input.identity)
  const connectionKey = spaceKey(identity)
  const factory = input.factory ?? globalThis.indexedDB
  const name = input.name ?? databaseName
  const signal = input.signal
  const transactions = new Set<IDBTransaction>()
  let disposed = false
  let database: IDBDatabase | undefined
  let opening: Promise<IDBDatabase> | undefined
  const key = (requestID: string): IDBValidKey => [connectionKey, requestID]
  function current() {
    signal?.throwIfAborted()
    if (disposed) throw new Error("Publication recovery storage has closed")
  }
  function changed() {
    for (const entry of changes) if (entry.key === connectionKey) entry.notify()
  }
  function open() {
    current()
    if (opening) return opening
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) {
        reject(new Error("Persistent publication recovery is unavailable"))
        return
      }
      const request = factory.open(name, 1)
      let rejected = false
      request.onupgradeneeded = () => initialize(request.result)
      request.onblocked = () => {
        rejected = true
        reject(new Error("Publication recovery storage is held by another page"))
      }
      request.onerror = () => {
        rejected = true
        reject(request.error ?? new Error("Persistent publication recovery is unavailable"))
      }
      request.onsuccess = () => {
        if (disposed || signal?.aborted || rejected) {
          request.result.close()
          reject(new Error("Publication recovery storage has closed"))
          return
        }
        database = request.result
        database.onversionchange = dispose
        resolve(database)
      }
    })
    opening = pending
    void pending.catch(() => {
      if (opening === pending) opening = undefined
    })
    return pending
  }
  async function transaction<T>(mode: IDBTransactionMode, operation: (table: IDBObjectStore) => Promise<T>) {
    const db = await open()
    current()
    const work = db.transaction(tableName, mode)
    transactions.add(work)
    const complete = done(work)
    void complete.catch(() => {})
    try {
      const value = await operation(work.objectStore(tableName))
      await complete
      current()
      if (mode === "readwrite") changed()
      return value
    } catch (error) {
      try {
        work.abort()
      } catch {}
      await complete.catch(() => {})
      throw error
    } finally {
      transactions.delete(work)
    }
  }
  function parse(value: unknown) {
    const record = PublicationRecord.parse(value)
    if (record.connectionKey !== connectionKey) throw new Error("Publication belongs to another space")
    return record
  }
  function stored(value: unknown) {
    return value === undefined ? undefined : parse(value)
  }
  async function existing(table: IDBObjectStore, record: PublicationRecord) {
    const previous = stored(await read(table.get(key(record.request.requestID))))
    if (
      !previous ||
      previous.requestHash !== record.requestHash ||
      previous.upload.manifestHash !== record.upload.manifestHash
    )
      throw new Error("The original publication metadata has changed")
    return previous
  }
  function dispose() {
    if (disposed) return
    disposed = true
    signal?.removeEventListener("abort", dispose)
    for (const work of transactions) {
      try {
        work.abort()
      } catch {}
    }
    transactions.clear()
    database?.close()
  }
  signal?.addEventListener("abort", dispose, { once: true })
  return {
    dispose,
    async put(value: PublicationRecord) {
      const record = parse(value)
      return transaction("readwrite", async (table) => {
        const previous = stored(await read(table.get(key(record.request.requestID))))
        if (previous) {
          if (
            previous.requestHash !== record.requestHash ||
            JSON.stringify(previous.upload) !== JSON.stringify(record.upload)
          )
            throw new Error("The original publication metadata has changed")
          return previous
        }
        await read(table.add(record))
        return record
      })
    },
    get(requestID: string) {
      return transaction("readonly", async (table) => stored(await read(table.get(key(requestID)))))
    },
    async page(query: {
      purpose: "knowledge" | "artifact"
      scope: Publication.Scope
      limit?: number
      cursor?: string
    }) {
      const purpose = query.purpose
      const scope = publicationScopeKey(query.scope)
      const limit = z
        .number()
        .int()
        .min(1)
        .max(32)
        .parse(query.limit ?? 16)
      const cursor = query.cursor ? Cursor.parse(JSON.parse(query.cursor)) : undefined
      if (cursor && (cursor.key !== connectionKey || cursor.purpose !== purpose || cursor.scope !== scope))
        throw new Error("Publication recovery cursor belongs to another source")
      const prefix = [connectionKey, purpose, scope]
      const range = IDBKeyRange.bound(
        cursor ? [...prefix, cursor.createdAt, cursor.requestID] : prefix,
        [...prefix, []],
        !!cursor,
      )
      return transaction("readonly", async (table) => {
        const rows = (await read(table.index("scope").getAll(range, limit + 1))).map(stored)
        const items = rows.slice(0, limit).filter((row) => row !== undefined)
        const last = items.at(-1)
        return {
          items,
          cursor:
            rows.length > limit && last
              ? JSON.stringify({
                  key: connectionKey,
                  purpose,
                  scope,
                  createdAt: last.createdAt,
                  requestID: last.request.requestID,
                })
              : undefined,
        }
      })
    },
    attempt(value: PublicationRecord) {
      const record = parse(value)
      return transaction("readwrite", async (table) => {
        const next = publicationAttempt(await existing(table, record))
        await read(table.put(next))
        return next
      })
    },
    failed(value: PublicationRecord, notDispatched: boolean) {
      const record = parse(value)
      return transaction("readwrite", async (table) => {
        const previous = stored(await read(table.get(key(record.request.requestID))))
        if (!previous || previous.requestHash !== record.requestHash || previous.attempt !== record.attempt) return
        const next = publicationFailed(previous, notDispatched)
        await read(table.put(next))
        return next
      })
    },
    confirm(value: PublicationRecord, result: unknown) {
      const record = parse(value)
      const confirmed = publicationConfirmed(record, result)
      return transaction("readwrite", async (table) => {
        const previous = stored(await read(table.get(key(record.request.requestID))))
        if (previous) {
          if (previous.requestHash !== record.requestHash)
            throw new Error("The original publication metadata has changed")
          await read(table.delete(key(record.request.requestID)))
        }
        return confirmed
      })
    },
  }
}
export async function removeOrganizationPublications(
  connectionKey: string,
  factory: IDBFactory = globalThis.indexedDB,
  signal?: AbortSignal,
) {
  if (!factory) throw new Error("Persistent publication recovery is unavailable")
  signal?.throwIfAborted()
  const request = factory.open(databaseName, 1)
  request.onupgradeneeded = () => {
    if (signal?.aborted) request.transaction?.abort()
    else initialize(request.result)
  }
  let db: IDBDatabase | undefined
  let work: IDBTransaction | undefined
  let rejectOpen: (error: unknown) => void = () => {}
  let rejected = false
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    rejectOpen = (error) => {
      rejected = true
      reject(error)
    }
    request.onsuccess = () => {
      if (rejected || signal?.aborted) {
        request.result.close()
        rejectOpen(signal?.reason ?? new Error("Publication recovery cleanup has closed"))
      } else resolve(request.result)
    }
    request.onerror = () => rejectOpen(request.error ?? new Error("Publication recovery cleanup failed"))
    request.onblocked = () => rejectOpen(new Error("Publication recovery cleanup is held by another page"))
  })
  const cancel = () => {
    rejectOpen(signal?.reason ?? new Error("Publication recovery cleanup has closed"))
    try {
      work?.abort()
    } catch {}
  }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    if (signal?.aborted) cancel()
    db = await opening
    signal?.throwIfAborted()
    work = db.transaction(tableName, "readwrite")
    const complete = done(work)
    void complete.catch(() => {})
    signal?.throwIfAborted()
    const cursor = work.objectStore(tableName).index("connection").openCursor(IDBKeyRange.only(connectionKey))
    cursor.onsuccess = () => {
      if (signal?.aborted) return
      const row = cursor.result
      if (!row) return
      row.delete()
      row.continue()
    }
    await complete
    signal?.throwIfAborted()
  } catch (error) {
    try {
      work?.abort()
    } catch {}
    throw error
  } finally {
    signal?.removeEventListener("abort", cancel)
    db?.close()
  }
}
