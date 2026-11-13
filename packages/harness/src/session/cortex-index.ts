import { z } from "zod"
import { Storage } from "../storage/storage"
import { SessionPreparingError, StorageConflictError, StorageIntegrityError } from "../storage/errors"
import { CortexDelegationSummary, type Info } from "./types"

export namespace SessionCortexIndex {
  const ID = z.string().min(1)
  const Header = z.strictObject({
    version: z.literal(1),
    scopeID: ID,
    parentSessionID: ID,
    ready: z.boolean(),
    total: z.number().int().nonnegative().safe(),
  })
  export const Item = CortexDelegationSummary.omit({ visibility: true }).extend({
    sessionID: ID,
    description: z.string().max(512),
  })
  export type Item = z.infer<typeof Item>
  const Cursor = z.strictObject({ version: z.literal(1), scopeID: ID, parentSessionID: ID, after: ID })
  export const key = (scopeID: string, parentSessionID: string) => ["session_cortex_index", scopeID, parentSessionID]
  const items = (scopeID: string, parentSessionID: string) => [...key(scopeID, parentSessionID), "items"]
  const itemKey = (scopeID: string, parentSessionID: string, sessionID: string) => [
    ...items(scopeID, parentSessionID),
    sessionID,
  ]

  function writing() {
    if (!Storage.inWriteTransaction())
      throw new StorageConflictError("Cortex metadata must join its native Session writer")
  }

  async function header(scopeID: string, parentSessionID: string) {
    const [value] = await Storage.readMany([key(scopeID, parentSessionID)])
    if (value === undefined) return
    const current = Header.parse(value)
    if (current.scopeID !== scopeID || current.parentSessionID !== parentSessionID)
      throw new StorageIntegrityError("Cortex metadata index belongs to another parent")
    return current
  }

  export async function initialize(scopeID: string, parentSessionID: string, ready: boolean) {
    writing()
    const current = await header(scopeID, parentSessionID)
    if (current) return current
    const value = Header.parse({ version: 1, scopeID, parentSessionID, ready, total: 0 })
    await Storage.write(key(scopeID, parentSessionID), value)
    return value
  }

  export async function ready(scopeID: string, parentSessionID: string) {
    return (await header(scopeID, parentSessionID))?.ready === true
  }

  export async function prepare(scopeID: string, parentSessionID: string) {
    if (await ready(scopeID, parentSessionID)) return
    if (Storage.inTransaction())
      throw new SessionPreparingError({
        sessionID: parentSessionID,
        message: "Prepare Cortex task metadata before reading its pages",
      })
    const { prepareSessionMigrations } = await import("../migration")
    await prepareSessionMigrations({ scopeID, sessionID: parentSessionID })
    if (!(await ready(scopeID, parentSessionID)))
      throw new StorageIntegrityError("Completed Cortex metadata preparation has no current index")
  }

  function project(session: Pick<Info, "id" | "scope" | "parentID" | "cortex">) {
    const cortex = session.cortex
    if (!cortex || !session.parentID || cortex.visibility === "hidden") return
    if (session.parentID !== cortex.parentSessionID)
      throw new StorageIntegrityError("Cortex metadata has another native parent")
    return Item.parse({ ...cortex, sessionID: session.id, description: cortex.description.slice(0, 512) })
  }

  async function removeItem(scopeID: string, parentSessionID: string, sessionID: string) {
    const current = await header(scopeID, parentSessionID)
    if (!current) return
    const destination = itemKey(scopeID, parentSessionID, sessionID)
    const [previous] = await Storage.readMany([destination])
    if (previous === undefined) return
    await Storage.remove(destination)
    await Storage.write(key(scopeID, parentSessionID), Header.parse({ ...current, total: current.total - 1 }))
  }

  export async function sync(session: Info, previous?: Info) {
    writing()
    const value = project(session)
    if (previous?.parentID && (previous.parentID !== session.parentID || !value))
      await removeItem(previous.scope.id, previous.parentID, previous.id)
    if (!value || !session.parentID) return
    const current = await initialize(session.scope.id, session.parentID, false)
    const destination = itemKey(session.scope.id, session.parentID, session.id)
    const [existing] = await Storage.readMany([destination])
    await Storage.write(destination, value)
    if (existing === undefined)
      await Storage.write(
        key(session.scope.id, session.parentID),
        Header.parse({ ...current, total: current.total + 1 }),
      )
  }

  export async function remove(session: Info) {
    writing()
    if (session.parentID) await removeItem(session.scope.id, session.parentID, session.id)
    await Storage.removeTree(key(session.scope.id, session.id))
  }

  export async function rebuild(scopeID: string, parentSessionID: string, children: AsyncIterable<Info>) {
    writing()
    await header(scopeID, parentSessionID)
    await Storage.removeTree(key(scopeID, parentSessionID))
    await initialize(scopeID, parentSessionID, false)
    for await (const child of children) {
      if (child.scope.id !== scopeID || child.parentID !== parentSessionID)
        throw new StorageIntegrityError("Cortex metadata upgrade crossed its native parent")
      await sync(child)
    }
    const current = await header(scopeID, parentSessionID)
    if (!current) throw new StorageIntegrityError("Cortex metadata upgrade lost its header")
    await Storage.write(key(scopeID, parentSessionID), { ...current, ready: true })
  }

  export async function completeScope(scopeID: string) {
    writing()
    for await (const row of Storage.records({ prefix: ["session_cortex_index", scopeID], limit: 128 })) {
      if (row.key.length !== 3) continue
      const current = Header.parse(row.value)
      if (current.scopeID !== scopeID || current.parentSessionID !== row.key[2])
        throw new StorageIntegrityError("Cortex metadata header changed identity")
      await Storage.write(row.key, { ...current, ready: true })
    }
  }

  export async function page(scopeID: string, parentSessionID: string, value: { limit?: number; cursor?: string }) {
    const input = z
      .strictObject({
        limit: z.number().int().min(1).max(64).default(32),
        cursor: z.string().min(1).max(8192).optional(),
      })
      .parse(value)
    const cursor = input.cursor
      ? Cursor.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()))
      : undefined
    if (cursor && (cursor.scopeID !== scopeID || cursor.parentSessionID !== parentSessionID))
      throw new StorageIntegrityError("Cortex cursor belongs to another native parent")
    return Storage.snapshot(async () => {
      const current = await header(scopeID, parentSessionID)
      if (!current?.ready)
        throw new SessionPreparingError({ sessionID: parentSessionID, message: "Cortex task metadata is preparing" })
      const prefix = items(scopeID, parentSessionID)
      const rows = await Storage.query({
        prefix,
        after: cursor ? [...prefix, cursor.after] : undefined,
        limit: input.limit + 1,
      })
      const page = rows.slice(0, input.limit).map((row) => {
        const task = Item.parse(row.value)
        if (row.key.length !== 5 || row.key[4] !== task.sessionID || task.parentSessionID !== parentSessionID)
          throw new StorageIntegrityError("Cortex task metadata row changed identity")
        return task
      })
      const last = page.at(-1)
      return {
        items: page,
        total: current.total,
        cursor:
          rows.length > input.limit && last
            ? Buffer.from(JSON.stringify({ version: 1, scopeID, parentSessionID, after: last.sessionID })).toString(
                "base64url",
              )
            : undefined,
      }
    })
  }
}
