import { expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionNav, type ScopeNavIndex } from "../../src/session/nav"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageCompat } from "../../src/storage/compat"
import { withStorageQueueOptions } from "../../src/storage/queue"
import { Identifier } from "../../src/id/id"

test("committed navigation reads finish before an unrelated writer is released", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Session.create({ title: "Committed navigation" })
        const key = StoragePath.sessionNavIndex(Identifier.asScopeID(scope.id))
        const committed = await Storage.read<ScopeNavIndex>(key)
        const unpublished = {
          ...committed,
          entries: committed.entries.map((entry) => ({ ...entry, title: "Uncommitted navigation" })),
        }
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let wasReleased = false
        const writer = Storage.transaction(async () => {
          await Storage.write(key, unpublished)
          expect(await SessionNav.readNavIndex(scope.id)).toEqual(unpublished)
          expect((await SessionNav.queryScope(scope.id)).items).toEqual(unpublished.entries)
          entered.resolve()
          await release.promise
        })
        void writer.catch(entered.reject)
        const rescue = setTimeout(() => {
          wasReleased = true
          release.resolve()
        }, 5_000)
        let readIndex: Promise<ScopeNavIndex> | undefined
        let queryScope: ReturnType<typeof SessionNav.queryScope> | undefined
        try {
          await entered.promise
          readIndex = SessionNav.readNavIndex(scope.id)
          queryScope = SessionNav.queryScope(scope.id)
          const index = await readIndex
          expect(wasReleased).toBe(false)
          expect(index).toEqual(committed)
          const page = await queryScope
          expect(wasReleased).toBe(false)
          expect(page.items).toEqual(committed.entries)
        } finally {
          clearTimeout(rescue)
          release.resolve()
          await Promise.allSettled([writer, readIndex, queryScope])
          await writer
        }
        expect(await SessionNav.readNavIndex(scope.id)).toEqual(unpublished)
      },
    })
  })
}, 15_000)

test("concurrent cold navigation reads publish one complete index", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const first = await Session.create({ title: "First canonical session", tags: ["focus"] })
        const second = await Session.create({ title: "Second canonical session" })
        const key = StoragePath.sessionNavIndex(Identifier.asScopeID(scope.id))
        const previous = await Storage.versioned<ScopeNavIndex>(key)
        await Storage.remove(key)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const writer = Storage.transaction(async () => {
          entered.resolve()
          await release.promise
        })
        void writer.catch(entered.reject)
        const rescue = setTimeout(() => release.resolve(), 5_000)
        const reads: Promise<ScopeNavIndex>[] = []
        try {
          await entered.promise
          for (let count = 0; count < 2; count++) {
            const queued = Promise.withResolvers<void>()
            reads.push(
              withStorageQueueOptions({ onWait: (waiting) => waiting && queued.resolve() }, () =>
                SessionNav.readNavIndex(scope.id),
              ),
            )
            void reads.at(-1)!.catch(queued.reject)
            await Promise.race([
              queued.promise,
              writer.then(() => {
                throw new Error("Cold navigation did not enter writer admission")
              }),
            ])
          }
          release.resolve()
          const indexes = await Promise.all(reads)
          expect(indexes[0].entries.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort())
          expect(indexes[0]).toEqual(indexes[1])
          const stored = await Storage.versioned<ScopeNavIndex>(key)
          expect(stored.value).toEqual(indexes[0])
          expect(stored.revision).toBe(previous.revision + 2n)
        } finally {
          clearTimeout(rescue)
          release.resolve()
          await Promise.allSettled([writer, ...reads])
          await writer
        }
      },
    })
  })
}, 15_000)

test("a cold navigation read rechecks the index after its writer admission", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const scopeID = "home"
    const key = StoragePath.sessionNavIndex(Identifier.asScopeID(scopeID))
    await Storage.remove(key)
    const published: ScopeNavIndex = { version: 1, scopeID, updatedAt: 123, entries: [] }
    const entered = Promise.withResolvers<void>()
    const queued = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let wasReleased = false
    const writer = Storage.transaction(async () => {
      await Storage.write(key, published)
      entered.resolve()
      await release.promise
    })
    void writer.catch(entered.reject)
    const rescue = setTimeout(() => {
      wasReleased = true
      release.resolve()
      queued.reject(new Error("Cold navigation did not enter writer admission"))
    }, 5_000)
    let readIndex: Promise<ScopeNavIndex> | undefined
    try {
      await entered.promise
      readIndex = withStorageQueueOptions({ onWait: (waiting) => waiting && queued.resolve() }, () =>
        SessionNav.readNavIndex(scopeID),
      )
      await queued.promise
      expect(wasReleased).toBe(false)
      release.resolve()
      expect(await readIndex).toEqual(published)
      await writer
      expect(await Storage.read<ScopeNavIndex>(key)).toEqual(published)
    } finally {
      clearTimeout(rescue)
      release.resolve()
      await Promise.allSettled([writer, readIndex])
    }
  })
}, 15_000)

test("navigation merges deferred catalog entries in its reader or writer snapshot", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const scopeID = "home"
    await ScopeContext.provide({
      scope: (await import("../../src/scope")).Scope.home(),
      fn: async () => {
        const canonical = await Session.create({ title: "Canonical entry", tags: ["focus"] })
        const key = StoragePath.sessionNavIndex(Identifier.asScopeID(scopeID))
        const index = await Storage.read<ScopeNavIndex>(key)
        const entry = index.entries.find((entry) => entry.id === canonical.id)!
        const pendingID = Identifier.descending("session")
        const pending = { ...canonical, id: pendingID, title: "Deferred entry", time: { created: 1, updated: 1 } }
        const locator: StorageCompat.Locator = { sessionID: pendingID, scopeID, activity: 1, status: "pending" }
        await Storage.write(StorageCompat.infoKey, { boundary: StorageCompat.boundary })
        await Storage.write(StorageCompat.catalogKey(locator), { ...locator, info: pending })
        const duplicate: StorageCompat.Locator = { ...locator, sessionID: canonical.id }
        await Storage.write(StorageCompat.catalogKey(duplicate), {
          ...duplicate,
          info: { ...canonical, title: "Stale catalog title" },
        })
        const quarantined: StorageCompat.Locator = {
          ...locator,
          sessionID: Identifier.descending("session"),
          status: "quarantined",
        }
        await Storage.write(StorageCompat.catalogKey(quarantined), {
          ...quarantined,
          info: { ...pending, id: quarantined.sessionID },
        })
        await withStorageQueueOptions({ deadline: performance.now() + 5_000 }, async () => {
          const merged = await SessionNav.readNavIndex(scopeID)
          expect(merged.entries).toEqual([entry, Session.toNavEntry(pending)])
          expect((await SessionNav.queryScope(scopeID, { tag: "#focus" })).items).toEqual(merged.entries)
          expect(await Storage.read<ScopeNavIndex>(key)).toEqual(index)
          await Storage.snapshot(async () => {
            await Storage.read<ScopeNavIndex>(key)
            await Storage.current().store.transaction(async (tx) => {
              await tx.write(StorageCompat.catalogKey(locator), {
                ...locator,
                info: { ...pending, title: "Later committed deferred entry" },
              })
            })
            expect((await SessionNav.readNavIndex(scopeID)).entries).toEqual(merged.entries)
          })
          expect((await SessionNav.readNavIndex(scopeID)).entries).toEqual([
            entry,
            Session.toNavEntry({ ...pending, title: "Later committed deferred entry" }),
          ])
          await Storage.transaction(async () => {
            const updated = { ...pending, title: "Writer-local deferred entry" }
            await Storage.write(StorageCompat.catalogKey(locator), { ...locator, info: updated })
            expect((await SessionNav.readNavIndex(scopeID)).entries).toEqual([entry, Session.toNavEntry(updated)])
          })
        })
      },
    })
  })
}, 15_000)

test("cold navigation keeps unpublished canonical records out of its persisted index", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const scopeID = "home"
    await ScopeContext.provide({
      scope: (await import("../../src/scope")).Scope.home(),
      fn: async () => {
        const canonical = await Session.create({ title: "Published session" })
        const pendingID = Identifier.descending("session")
        const pending = { ...canonical, id: pendingID, title: "Unpublished session" }
        const store = Storage.current().store
        await store.transaction(async (tx) => {
          await tx.write(StoragePath.sessionInfo(Identifier.asScopeID(scopeID), pendingID), pending)
          await StorageCompat.setLocator(tx, { sessionID: pendingID, scopeID, status: "partial" }, pending)
          await tx.write(StorageCompat.infoKey, { boundary: StorageCompat.boundary })
        })
        const key = StoragePath.sessionNavIndex(Identifier.asScopeID(scopeID))
        await Storage.remove(key)
        const merged = await SessionNav.readNavIndex(scopeID)
        expect(merged.entries.map((entry) => entry.id).sort()).toEqual([canonical.id, pendingID].sort())
        expect((await Storage.read<ScopeNavIndex>(key)).entries.map((entry) => entry.id)).toEqual([canonical.id])
        await expect(Storage.read(StoragePath.sessionInfo(Identifier.asScopeID(scopeID), pendingID))).rejects.toThrow(
          "preparation",
        )
      },
    })
  })
})
