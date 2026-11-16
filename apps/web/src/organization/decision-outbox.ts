import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import {
  DecisionOutboxOwner,
  DecisionOutboxRecord,
  decisionOutboxOwnerKey,
  prepareDecisionOutboxRecord,
  decisionOutboxCommandMatches,
} from "./decision-outbox-record"

const ownerFields = ["connectionKey", "accountID", "projectID", "rootSessionID", "sourceSessionID"]
const Cursor = z.strictObject({
  owner: DecisionOutboxOwner,
  createdAt: z.number().int().nonnegative().safe(),
  requestID: z.string().min(1),
})
const databaseName = "synergy.organization-decisions"
const records = "records"
const payloads = "payloads"
function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("The response record could not be read"))
  })
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("The response record transaction was aborted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("The response record could not be saved"))
  })
}
function initialize(database: IDBDatabase) {
  const table = database.createObjectStore(records, { keyPath: [...ownerFields, "requestID"] })
  table.createIndex("source", [...ownerFields, "createdAt", "requestID"])
  table.createIndex("native", [...ownerFields, "kind", "nativeID"], { unique: true })
  table.createIndex("connection", "connectionKey")
  database.createObjectStore(payloads)
}

export function createOrganizationDecisionOutbox(input: {
  owner: DecisionOutboxOwner
  binding: Protocol.SessionBinding
  factory?: IDBFactory
  name?: string
}) {
  const owner = DecisionOutboxOwner.parse(input.owner)
  const ownerKey = decisionOutboxOwnerKey(owner)
  const volatile = new Map<string, Command.DecisionRequest>()
  const transactions = new Set<IDBTransaction>()
  let disposed = false
  let database: IDBDatabase | undefined
  let opening: Promise<IDBDatabase> | undefined
  const key = (requestID: string): IDBValidKey => [...ownerKey, requestID]
  const current = () => {
    if (disposed) throw new Error("The response store has been closed")
  }
  function open() {
    current()
    if (opening) return opening
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = input.factory ?? globalThis.indexedDB
      if (!factory) {
        reject(new Error("Persistent response storage is unavailable"))
        return
      }
      const request = factory.open(input.name ?? databaseName, 1)
      let rejected = false
      request.onupgradeneeded = () => initialize(request.result)
      request.onblocked = () => {
        rejected = true
        reject(new Error("Another page is holding an older response store"))
      }
      request.onerror = () => {
        rejected = true
        reject(request.error ?? new Error("Persistent response storage is unavailable"))
      }
      request.onsuccess = () => {
        if (disposed || rejected) {
          request.result.close()
          reject(new Error("The response store has been closed"))
          return
        }
        database = request.result
        database.onversionchange = () => dispose()
        resolve(database)
      }
    })
    opening = pending
    void pending.catch(() => {
      if (opening === pending) opening = undefined
    })
    return opening
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await open()
    current()
    const work = db.transaction([records, payloads], mode)
    transactions.add(work)
    const complete = done(work)
    void complete.catch(() => {})
    try {
      const value = await operation(work)
      await complete
      current()
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
    return value === undefined ? undefined : DecisionOutboxRecord.parse(value)
  }
  async function get(requestID: string) {
    return transaction("readonly", async (work) =>
      parse(await readRequest(work.objectStore(records).get(key(requestID)))),
    )
  }
  async function native(kind: "question" | "permission", nativeID: string) {
    return transaction("readonly", async (work) =>
      parse(
        await readRequest(
          work
            .objectStore(records)
            .index("native")
            .get([...ownerKey, kind, nativeID]),
        ),
      ),
    )
  }
  function release(requestID: string) {
    volatile.delete(requestID)
  }
  function dispose() {
    if (disposed) return
    disposed = true
    volatile.clear()
    for (const work of transactions) {
      try {
        work.abort()
      } catch {}
    }
    transactions.clear()
    database?.close()
  }
  return {
    get,
    native,
    async nativePage(identities: readonly { kind: "question" | "permission"; nativeID: string }[]) {
      if (identities.length > 64) throw new Error("The response identity page is too large")
      return transaction("readonly", (work) =>
        Promise.all(
          identities.map((identity) =>
            readRequest(
              work
                .objectStore(records)
                .index("native")
                .get([...ownerKey, identity.kind, identity.nativeID]),
            ).then(parse),
          ),
        ),
      )
    },
    release,
    dispose,
    available: (record: DecisionOutboxRecord) => !record.sensitive || volatile.has(record.requestID),
    async begin(command: Command.DecisionRequest, sensitive: boolean) {
      const record = await prepareDecisionOutboxRecord({
        owner,
        binding: input.binding,
        command,
        sensitive,
        createdAt: Date.now(),
      })
      const result = await transaction("readwrite", async (work) => {
        const table = work.objectStore(records)
        const previous = parse(
          await readRequest(table.index("native").get([...ownerKey, record.kind, record.nativeID])),
        )
        if (previous) {
          if (previous.requestHash !== record.requestHash || previous.sensitive !== record.sensitive)
            throw new Error("Check the original response before submitting another answer")
          return { record: previous, added: false }
        }
        await readRequest(table.add(record))
        if (!sensitive)
          await readRequest(
            work.objectStore(payloads).add(Command.DecisionRequest.parse(command), key(record.requestID)),
          )
        return { record, added: true }
      })
      if (result.added && sensitive) volatile.set(record.requestID, Command.DecisionRequest.parse(command))
      return result.record
    },
    async command(record: DecisionOutboxRecord) {
      current()
      const stored = await get(record.requestID)
      if (!stored || stored.requestHash !== record.requestHash)
        throw new Error("The original response record has changed")
      const value = stored.sensitive
        ? volatile.get(stored.requestID)
        : await transaction("readonly", (work) => readRequest(work.objectStore(payloads).get(key(stored.requestID))))
      if (value === undefined) return
      if (!(await decisionOutboxCommandMatches(stored, value)))
        throw new Error("The original response payload has changed")
      current()
      return Command.DecisionRequest.parse(value)
    },
    async remove(record: DecisionOutboxRecord) {
      const removed = await transaction("readwrite", async (work) => {
        const table = work.objectStore(records)
        const previous = parse(await readRequest(table.get(key(record.requestID))))
        if (!previous) return false
        if (previous.requestHash !== record.requestHash) throw new Error("The original response record has changed")
        await readRequest(table.delete(key(record.requestID)))
        await readRequest(work.objectStore(payloads).delete(key(record.requestID)))
        return true
      })
      release(record.requestID)
      return removed
    },
    async page(options: { cursor?: string; limit?: number } = {}) {
      const limit = z
        .number()
        .int()
        .min(1)
        .max(64)
        .parse(options.limit ?? 32)
      const cursor = options.cursor ? Cursor.parse(JSON.parse(options.cursor)) : undefined
      if (cursor && JSON.stringify(decisionOutboxOwnerKey(cursor.owner)) !== JSON.stringify(ownerKey))
        throw new Error("The response page belongs to another conversation")
      const lower = cursor ? [...ownerKey, cursor.createdAt, cursor.requestID] : [...ownerKey, 0, ""]
      const range = IDBKeyRange.bound(lower, [...ownerKey, Number.MAX_SAFE_INTEGER, "\uffff"], !!cursor, false)
      return transaction(
        "readonly",
        (work) =>
          new Promise<{ items: DecisionOutboxRecord[]; cursor?: string }>((resolve, reject) => {
            const items: DecisionOutboxRecord[] = []
            const request = work.objectStore(records).index("source").openCursor(range)
            request.onerror = () => reject(request.error ?? new Error("The response page could not be read"))
            request.onsuccess = () => {
              try {
                const row = request.result
                if (!row) {
                  resolve({ items })
                  return
                }
                if (items.length === limit) {
                  const last = items.at(-1)!
                  resolve({
                    items,
                    cursor: JSON.stringify({ owner, createdAt: last.createdAt, requestID: last.requestID }),
                  })
                  return
                }
                items.push(DecisionOutboxRecord.parse(row.value))
                row.continue()
              } catch (error) {
                reject(error)
              }
            }
          }),
      )
    },
  }
}

export async function removeOrganizationDecisionOutbox(
  connectionKey: string,
  factory: IDBFactory = globalThis.indexedDB,
) {
  if (!factory) throw new Error("Persistent response storage is unavailable")
  const request = factory.open(databaseName, 1)
  request.onupgradeneeded = () => initialize(request.result)
  const db = await readRequest(request)
  try {
    const work = db.transaction([records, payloads], "readwrite")
    const complete = done(work)
    const cursor = work.objectStore(records).index("connection").openCursor(IDBKeyRange.only(connectionKey))
    cursor.onsuccess = () => {
      const row = cursor.result
      if (!row) return
      work.objectStore(payloads).delete(row.primaryKey)
      row.delete()
      row.continue()
    }
    await complete
  } finally {
    db.close()
  }
}
