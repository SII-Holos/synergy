import { expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCompat } from "../../src/storage/compat"
import { runMigrations } from "../../src/migration"
import { Identifier } from "../../src/id/id"
import { testRuntime } from "../support/runtime"

test("native child pages retain exact counts and seek after removal without a whole-parent record", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const other = await Session.create({ workspace: null })
        const children: string[] = []
        for (let index = 0; index < 73; index++) {
          const child = await Session.create({
            parentID: parent.id,
            title: `Child ${String(index).padStart(3, "0")}`,
            workspace: null,
          })
          children.push(child.id)
        }
        await Session.create({ parentID: other.id, title: "Foreign child", workspace: null })
        await Session.update(children[0]!, (draft) => {
          draft.time.archived = Date.now()
        })
        const key = StoragePath.sessionChildIndex(Identifier.asScopeID("home"), Identifier.asSessionID(parent.id))
        const header = await Storage.read<Record<string, unknown>>(key)
        expect(header.version).toBe(2)
        expect(header).not.toHaveProperty("entries")
        expect(header).toMatchObject({ total: 73, active: 72 })
        const first = await Session.childPage({ parentID: parent.id, limit: 9 })
        expect(first.items).toHaveLength(9)
        expect(first.total).toBe(72)
        const cursor = first.nextCursor!
        const ids = new Set(first.items.map((child) => child.id))
        await Session.remove(cursor.id)
        let next = cursor
        for (;;) {
          const page = await Session.childPage({ parentID: parent.id, limit: 9, cursor: next })
          expect(page.items.every((child) => child.parentID === parent.id)).toBeTrue()
          expect(page.items.every((child) => !ids.has(child.id))).toBeTrue()
          page.items.forEach((child) => ids.add(child.id))
          if (!page.nextCursor) break
          next = page.nextCursor
        }
        expect(ids.size).toBe(72)
        const search = await Session.childPage({
          parentID: parent.id,
          limit: 2,
          search: "Child 00",
          includeArchived: true,
        })
        expect(search.items).toHaveLength(2)
        expect(search.total).toBe(10 - (children.slice(0, 10).includes(cursor.id) ? 1 : 0))
      },
    }),
  )
})

test("child metadata iteration is owner-qualified, cancellable and preserves historical v1 members", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const child = await Session.create({ parentID: parent.id, title: "Retained child", workspace: null })
        const key = StoragePath.sessionChildIndex(Identifier.asScopeID("home"), Identifier.asSessionID(parent.id))
        await Storage.removeTree(key)
        await Storage.write(key, {
          version: 1,
          scopeID: "home",
          parentID: parent.id,
          updatedAt: 1,
          entries: [Session.toChildIndexEntry(child)],
        })
        await runMigrations({ targetDomain: "session-child-index", maintenance: true, output: "silent" })
        expect(await Storage.read(key)).toMatchObject({ version: 2, total: 1, active: 1 })
        const found = []
        for await (const entry of Session.childEntries(parent.id)) found.push(entry)
        expect(found.map((entry) => entry.id)).toEqual([child.id])
        expect(await Storage.read(key)).toMatchObject({ version: 2, total: 1, active: 1 })
        const cancelled = new AbortController()
        cancelled.abort(new Error("child iteration cancelled"))
        await expect(Session.childEntries(parent.id, cancelled.signal).next()).rejects.toThrow(
          "child iteration cancelled",
        )
        await Storage.remove(key)
        await expect(Session.childPage({ parentID: parent.id, limit: 1 })).rejects.toThrow("canonical header")
        await Storage.write(key, {
          version: 99,
          scopeID: "home",
          parentID: parent.id,
          total: 1,
          active: 1,
          updatedAt: 1,
        })
        await expect(Session.childPage({ parentID: parent.id, limit: 1 })).rejects.toThrow()
      },
    }),
  )
})

test("child metadata merges interleaved deferred catalog pages without another parent's members or duplicates", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const other = await Session.create({ workspace: null })
        const child = await Session.create({ parentID: parent.id, title: "Canonical child", workspace: null })
        const info = await Storage.read<Record<string, unknown>>(["sessions", "home", child.id, "info"])
        await Storage.transaction(async (tx) => {
          for (let index = 0; index < 260; index++) {
            const id = Identifier.ascending("session")
            const owner = index % 2 === 0 ? parent : other
            const value = {
              ...info,
              id,
              parentID: owner.id,
              title: `Deferred ${index}`,
              time: { created: index + 1, updated: index + 1 },
            }
            await StorageCompat.setLocator(
              tx,
              { sessionID: id, scopeID: "home", status: "pending", activity: index + 1 },
              value,
            )
          }
          await StorageCompat.setLocator(
            tx,
            { sessionID: child.id, scopeID: "home", status: "partial", activity: 999 },
            info,
          )
        })
        const entries = []
        for await (const entry of Session.childEntries(parent.id)) entries.push(entry)
        expect(entries).toHaveLength(131)
        expect(new Set(entries.map((entry) => entry.id)).size).toBe(131)
        const first = await Session.childPage({ parentID: parent.id, limit: 13 })
        expect(first.total).toBe(131)
        expect(first.items).toHaveLength(13)
        expect(first.items.every((entry) => entry.parentID === parent.id)).toBeTrue()
      },
    }),
  )
})
