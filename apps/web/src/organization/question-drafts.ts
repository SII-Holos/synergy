import { z } from "zod"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { QuestionDraftSchema, type QuestionDraft } from "@/components/session/question-prompt-model"
import { Persist } from "@/utils/persist"
import {
  OrganizationQuestionDraftOwner,
  type OrganizationQuestionDraftRecord,
  organizationQuestionDraftOwnerKey,
  prepareOrganizationQuestionDraft,
  restoreOrganizationQuestionDraft,
  importOrganizationQuestionDraft,
} from "./question-draft-record"

const databaseName = "synergy.organization-question-drafts"
const drafts = "drafts"
const migrations = "migrations"
const owners = new Set<{ connectionKey: string; dispose(): void }>()
const Receipt = OrganizationQuestionDraftOwner.extend({ version: z.literal(1), state: z.literal("complete") }).strict()
const Legacy = z.strictObject({
  version: z.literal(2),
  entries: z.record(z.string(), QuestionDraftSchema.extend({ inputTypes: z.array(z.enum(["text", "password"])) })),
})
type QuestionIdentity = Pick<QuestionRequest, "sessionID" | "id">
type DraftStorage = Pick<Storage, "getItem" | "removeItem">
function initialize(database: IDBDatabase) {
  const rows = database.createObjectStore(drafts)
  rows.createIndex("connection", "connectionKey")
  const receipts = database.createObjectStore(migrations)
  receipts.createIndex("connection", "connectionKey")
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error("Question draft storage is unavailable"))
  })
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("Question draft storage was interrupted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("Question draft storage is unavailable"))
  })
}

export function organizationQuestionDraftLegacyKey(owner: OrganizationQuestionDraftOwner) {
  const target = Persist.workspace(Persist.scopeKey(owner.connectionKey, owner.projectID), "question-drafts-v2")
  return `${target.storage}:${target.key}`
}
export function createOrganizationQuestionDrafts(input: {
  owner: OrganizationQuestionDraftOwner
  storage?: DraftStorage
  factory?: IDBFactory
  name?: string
  signal?: AbortSignal
}) {
  const owner = OrganizationQuestionDraftOwner.parse(input.owner)
  const ownerKey = organizationQuestionDraftOwnerKey(owner)
  const legacyKey = organizationQuestionDraftLegacyKey(owner)
  const active = new Set<IDBTransaction>()
  let database: IDBDatabase | undefined
  let opening: Promise<IDBDatabase> | undefined
  let preparation: Promise<void> | undefined
  let disposed = false
  const registration = { connectionKey: owner.connectionKey, dispose }
  owners.add(registration)
  const current = () => {
    if (disposed || input.signal?.aborted) throw new Error("The question draft owner has been closed")
  }
  const key = (identity: QuestionIdentity): IDBValidKey => [
    ...ownerKey,
    Identity.ID.parse(identity.sessionID),
    Identity.ID.parse(identity.id),
  ]
  function dispose() {
    if (disposed) return
    disposed = true
    owners.delete(registration)
    for (const transaction of active) {
      try {
        transaction.abort()
      } catch {}
    }
    active.clear()
    database?.close()
    input.signal?.removeEventListener("abort", dispose)
  }
  input.signal?.addEventListener("abort", dispose, { once: true })
  function open() {
    current()
    if (opening) return opening
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = input.factory ?? globalThis.indexedDB
      if (!factory) {
        reject(new Error("Persistent question draft storage is unavailable"))
        return
      }
      const opening = factory.open(input.name ?? databaseName, 1)
      let rejected = false
      opening.onupgradeneeded = () => initialize(opening.result)
      opening.onerror = () => {
        rejected = true
        reject(opening.error ?? new Error("Persistent question draft storage is unavailable"))
      }
      opening.onblocked = () => {
        rejected = true
        reject(new Error("Another page is holding an older question draft store"))
      }
      opening.onsuccess = () => {
        if (disposed || rejected || input.signal?.aborted) {
          opening.result.close()
          reject(new Error("The question draft owner has been closed"))
          return
        }
        database = opening.result
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
  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (work: IDBTransaction) => Promise<T>,
    signal?: AbortSignal,
  ) {
    const database = await open()
    current()
    signal?.throwIfAborted()
    const work = database.transaction([drafts, migrations], mode)
    const abort = () => {
      try {
        work.abort()
      } catch {}
    }
    signal?.addEventListener("abort", abort, { once: true })
    active.add(work)
    const complete = completed(work)
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
      signal?.removeEventListener("abort", abort)
      active.delete(work)
    }
  }
  function verifyReceipt(value: unknown) {
    const receipt = Receipt.parse(value)
    if (JSON.stringify(organizationQuestionDraftOwnerKey(receipt)) !== JSON.stringify(ownerKey))
      throw new Error("The question draft migration belongs to another account")
  }
  function cleanupLegacy() {
    try {
      ;(input.storage ?? localStorage).removeItem(legacyKey)
    } catch {}
  }
  async function migrate() {
    const connection = z
      .tuple([z.literal("organization"), Identity.ID, Identity.ID, Identity.ID])
      .parse(JSON.parse(owner.connectionKey))
    if (connection[2] !== owner.accountID) throw new Error("The legacy question drafts belong to another account")
    const found = await transaction("readonly", (work) => request(work.objectStore(migrations).get(ownerKey)))
    if (found !== undefined) {
      verifyReceipt(found)
      cleanupLegacy()
      return
    }
    const raw = (input.storage ?? localStorage).getItem(legacyKey)
    let entries: [string, z.infer<typeof Legacy>["entries"][string]][] = []
    if (raw !== null) {
      entries = Object.entries(Legacy.parse(JSON.parse(raw)).entries)
    }
    await transaction("readwrite", async (work) => {
      const table = work.objectStore(migrations)
      const current = await request(table.get(ownerKey))
      if (current !== undefined) {
        verifyReceipt(current)
        return
      }
      for (const [encoded, value] of entries) {
        const identity = z.tuple([Identity.ID, Identity.ID]).parse(JSON.parse(encoded))
        const record = importOrganizationQuestionDraft(owner, identity, value)
        const target = key({ sessionID: record.sourceSessionID, id: record.requestID })
        if ((await request(work.objectStore(drafts).getKey(target))) === undefined)
          await request(work.objectStore(drafts).add(record, target))
      }
      await request(table.add(Receipt.parse({ ...owner, version: 1, state: "complete" }), ownerKey))
    })
    cleanupLegacy()
  }
  function ready() {
    current()
    if (preparation) return preparation
    const pending = migrate()
    preparation = pending
    void pending.catch(() => {
      if (preparation === pending) preparation = undefined
    })
    return pending
  }
  return {
    ready,
    async load(identity: QuestionRequest, signal?: AbortSignal) {
      signal?.throwIfAborted()
      await ready()
      const value = await transaction(
        "readonly",
        (work) => request<OrganizationQuestionDraftRecord | undefined>(work.objectStore(drafts).get(key(identity))),
        signal,
      )
      signal?.throwIfAborted()
      return value === undefined ? undefined : restoreOrganizationQuestionDraft(owner, identity, value)
    },
    async save(identity: QuestionRequest, value: QuestionDraft) {
      const record = prepareOrganizationQuestionDraft(owner, identity, value)
      await ready()
      await transaction("readwrite", (work) => request(work.objectStore(drafts).put(record, key(identity))))
    },
    async remove(identity: QuestionIdentity) {
      await ready()
      await transaction("readwrite", (work) => request(work.objectStore(drafts).delete(key(identity))))
    },
    dispose,
  }
}

export async function removeOrganizationQuestionDrafts(connectionKey: string, factory = globalThis.indexedDB) {
  for (const owner of owners) if (owner.connectionKey === connectionKey) owner.dispose()
  if (!factory) throw new Error("Persistent question draft storage is unavailable")
  const opening = factory.open(databaseName, 1)
  opening.onupgradeneeded = () => initialize(opening.result)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let rejected = false
    opening.onblocked = () => {
      rejected = true
      reject(new Error("Another page is holding the question draft store"))
    }
    opening.onerror = () => reject(opening.error ?? new Error("Question drafts could not be removed"))
    opening.onsuccess = () => {
      if (rejected) {
        opening.result.close()
        return
      }
      resolve(opening.result)
    }
  })
  const work = database.transaction([drafts, migrations], "readwrite")
  const complete = completed(work)
  void complete.catch(() => {})
  try {
    await Promise.all(
      [drafts, migrations].map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const table = work.objectStore(name)
            const cursor = table.index("connection").openKeyCursor(IDBKeyRange.only(connectionKey))
            cursor.onerror = () => reject(cursor.error ?? new Error("Question drafts could not be removed"))
            cursor.onsuccess = () => {
              const entry = cursor.result
              if (!entry) {
                resolve()
                return
              }
              table.delete(entry.primaryKey)
              entry.continue()
            }
          }),
      ),
    )
    await complete
  } catch (error) {
    try {
      work.abort()
    } catch {}
    await complete.catch(() => {})
    throw error
  } finally {
    database.close()
  }
}
