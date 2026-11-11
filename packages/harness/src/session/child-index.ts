import { z } from "zod"
import { Storage } from "../storage/storage"
import type { StoreTransaction } from "../storage/transactional-store"
import { StorageIntegrityError, SessionPreparingError } from "../storage/errors"
import { upgradeChildIndex } from "./child-index-migration"
import { SessionTransferGate } from "./transfer-gate"

export namespace SessionChildIndex {
  export const Entry = z.strictObject({
    id: z.string().min(1),
    title: z.string(),
    updated: z.number().nonnegative(),
    created: z.number().nonnegative(),
    archived: z.boolean(),
  })
  export type Entry = z.infer<typeof Entry>
  export const Header = z.strictObject({
    version: z.literal(2),
    scopeID: z.string().min(1),
    parentID: z.string().min(1),
    updatedAt: z.number().nonnegative(),
    total: z.number().int().nonnegative().safe(),
    active: z.number().int().nonnegative().safe(),
  })
  export type Header = z.infer<typeof Header>
  export type Cursor = { lastActivityAt: number; id: string }
  export const key = (scopeID: string, parentID: string) => ["session_child_index", scopeID, parentID]
  const itemKey = (scopeID: string, parentID: string, id: string) => [...key(scopeID, parentID), "items", id]
  function order(entry: Pick<Entry, "id" | "updated">) {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, entry.updated === 0 ? 0 : entry.updated, false)
    return Buffer.from(bytes).toString("hex") + ":" + entry.id
  }
  function compare(a: Entry, b: Entry) {
    return b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  }
  function empty(scopeID: string, parentID: string): Header {
    return { version: 2, scopeID, parentID, total: 0, active: 0, updatedAt: 0 }
  }
  function header(scopeID: string, parentID: string, value: unknown) {
    const parsed = Header.parse(value)
    if (parsed.scopeID !== scopeID || parsed.parentID !== parentID)
      throw new StorageIntegrityError("Child index belongs to another owner")
    return parsed
  }
  async function absent(tx: StoreTransaction, scopeID: string, parentID: string) {
    const page = await tx.childKeys({ prefix: key(scopeID, parentID), limit: 1, includeBranches: true })
    if (page.keys.length) throw new StorageIntegrityError("Child index rows require their canonical header")
    return empty(scopeID, parentID)
  }
  async function state(tx: StoreTransaction, scopeID: string, parentID: string): Promise<Header> {
    const [value] = await tx.readMany([key(scopeID, parentID)])
    if (value === undefined) return absent(tx, scopeID, parentID)
    if (Header.safeParse(value).success) return header(scopeID, parentID, value)
    return upgradeChildIndex(tx, scopeID, parentID, value)
  }
  export async function ensure(scopeID: string, parentID: string) {
    const [value] = await Storage.readMany([key(scopeID, parentID)])
    if (value === undefined) return Storage.snapshot((tx) => absent(tx, scopeID, parentID))
    if (Header.safeParse(value).success) return header(scopeID, parentID, value)
    if (Storage.inTransaction() && !Storage.inWriteTransaction())
      throw new SessionPreparingError({
        sessionID: parentID,
        message: "Child metadata must be upgraded before observing its rows",
      })
    return Storage.transaction((tx) => state(tx, scopeID, parentID))
  }
  async function put(tx: StoreTransaction, scopeID: string, parentID: string, entry: Entry) {
    await tx.write(itemKey(scopeID, parentID, entry.id), entry)
    await tx.write([...key(scopeID, parentID), "ordered", order(entry)], entry)
    if (!entry.archived) await tx.write([...key(scopeID, parentID), "active", order(entry)], entry)
  }
  async function removeOrder(tx: StoreTransaction, scopeID: string, parentID: string, entry: Entry) {
    await tx.remove([...key(scopeID, parentID), "ordered", order(entry)])
    if (!entry.archived) await tx.remove([...key(scopeID, parentID), "active", order(entry)])
  }
  export async function replace(tx: StoreTransaction, scopeID: string, parentID: string, entries: Iterable<Entry>) {
    await SessionTransferGate.assertOwnerMutation(parentID)
    await tx.removeTree(key(scopeID, parentID))
    const current = empty(scopeID, parentID)
    for (const value of entries) {
      const entry = Entry.parse(value)
      if ((await tx.readMany([itemKey(scopeID, parentID, entry.id)]))[0] !== undefined)
        throw new StorageIntegrityError("Duplicate child identity")
      await put(tx, scopeID, parentID, entry)
      current.total++
      if (!entry.archived) current.active++
    }
    current.updatedAt = Date.now()
    await tx.write(key(scopeID, parentID), Header.parse(current))
    return current
  }
  export async function upsert(scopeID: string, parentID: string, value: Entry, transaction?: StoreTransaction) {
    const entry = Entry.parse(value)
    const apply = async (tx: StoreTransaction) => {
      await SessionTransferGate.assertOwnerMutation(parentID)
      const current = await state(tx, scopeID, parentID)
      const [raw] = await tx.readMany([itemKey(scopeID, parentID, entry.id)])
      const previous = raw === undefined ? undefined : Entry.parse(raw)
      if (previous) await removeOrder(tx, scopeID, parentID, previous)
      await put(tx, scopeID, parentID, entry)
      current.total += previous ? 0 : 1
      current.active += Number(!entry.archived) - Number(previous !== undefined && !previous.archived)
      current.updatedAt = Date.now()
      await tx.write(key(scopeID, parentID), Header.parse(current))
    }
    return transaction ? apply(transaction) : Storage.transaction(apply)
  }
  export async function remove(scopeID: string, parentID: string, id: string) {
    return Storage.transaction(async (tx) => {
      await SessionTransferGate.assertOwnerMutation(parentID)
      const current = await state(tx, scopeID, parentID)
      const [value] = await tx.readMany([itemKey(scopeID, parentID, id)])
      if (value === undefined) return
      const entry = Entry.parse(value)
      await removeOrder(tx, scopeID, parentID, entry)
      await tx.remove(itemKey(scopeID, parentID, id))
      current.total--
      current.active -= Number(!entry.archived)
      current.updatedAt = Date.now()
      await tx.write(key(scopeID, parentID), Header.parse(current))
    })
  }
  export async function contains(scopeID: string, parentID: string, id: string) {
    return (await Storage.readMany([itemKey(scopeID, parentID, id)]))[0] !== undefined
  }
  export async function* entries(scopeID: string, parentID: string, signal?: AbortSignal): AsyncGenerator<Entry> {
    signal?.throwIfAborted()
    const current = await ensure(scopeID, parentID)
    if (!current.total) return
    let after: string[] | undefined
    for (;;) {
      signal?.throwIfAborted()
      const page = await Storage.query({ prefix: [...key(scopeID, parentID), "items"], after, limit: 128 })
      for (const row of page) {
        signal?.throwIfAborted()
        const entry = Entry.parse(row.value)
        if (row.key.length !== 5 || row.key[4] !== entry.id)
          throw new StorageIntegrityError("Child index row identity changed")
        yield entry
      }
      if (page.length < 128) return
      after = page.at(-1)!.key
    }
  }
  export async function page(
    scopeID: string,
    parentID: string,
    input: {
      cursor?: Cursor | null
      limit?: number
      search?: string
      includeArchived?: boolean
      extras?: AsyncIterable<Entry>
    },
  ) {
    await ensure(scopeID, parentID)
    const limit = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(input.limit ?? 50)
    const search = input.search?.trim().toLowerCase()
    const prefix = [...key(scopeID, parentID), input.includeArchived ? "ordered" : "active"]
    return Storage.snapshot(async (tx) => {
      const current = await state(tx, scopeID, parentID)
      const selected: Entry[] = []
      const visible = (entry: Entry) =>
        (input.includeArchived || !entry.archived) && (!search || entry.title.toLowerCase().includes(search))
      function offer(entry: Entry) {
        if (!visible(entry)) return
        const cursor = input.cursor
        if (
          cursor &&
          (entry.updated > cursor.lastActivityAt || (entry.updated === cursor.lastActivityAt && entry.id >= cursor.id))
        )
          return
        selected.push(entry)
        selected.sort(compare)
        if (selected.length > limit + 1) selected.pop()
      }
      let total = search ? 0 : input.includeArchived ? current.total : current.active
      if (current.total) {
        let after =
          !search && input.cursor
            ? [...prefix, order({ updated: input.cursor.lastActivityAt, id: input.cursor.id })]
            : undefined
        for (;;) {
          const rows = await tx.query({ prefix, after, limit: search ? 128 : limit + 1, descending: true })
          for (const row of rows) {
            const entry = Entry.parse(row.value)
            if (row.key.length !== 5 || row.key[4] !== order(entry))
              throw new StorageIntegrityError("Child ordering identity changed")
            if (search && visible(entry)) total++
            offer(entry)
          }
          if (!search || rows.length < 128) break
          after = rows.at(-1)!.key
        }
      }
      if (input.extras)
        for await (const value of input.extras) {
          const entry = Entry.parse(value)
          if ((await tx.readMany([itemKey(scopeID, parentID, entry.id)]))[0] !== undefined) continue
          if (visible(entry)) total++
          offer(entry)
        }
      const more = selected.length > limit
      const items = selected.slice(0, limit)
      const last = items.at(-1)
      return { items, total, nextCursor: more && last ? { lastActivityAt: last.updated, id: last.id } : null }
    })
  }
}
