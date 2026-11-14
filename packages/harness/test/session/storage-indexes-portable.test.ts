import { expect, test } from "bun:test"
import path from "node:path"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionCortexIndex as Index } from "../../src/session/cortex-index"
import { Storage } from "../../src/storage/storage"
import { StoragePortable } from "../../src/storage/portable"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("portable native Session indexes rebuild Cortex metadata in the original import transaction and roll back together", async () => {
  await using directory = await tmpdir()
  await using source = await testRuntime()
  const native = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null, environmentID: null })
        const children: string[] = []
        for (const visibility of ["visible", "hidden"] as const) {
          const child = await Session.create({
            workspace: null,
            environmentID: null,
            parentID: parent.id,
            cortex: {
              taskID: Identifier.short("cortex"),
              parentSessionID: parent.id,
              parentMessageID: Identifier.ascending("message"),
              description: "Portable retained metadata",
              prompt: "Private input is not part of a Cortex summary page",
              status: "queued",
              agent: "general",
              startedAt: Date.now(),
              visibility,
            },
          })
          children.push(child.id)
        }
        return { parent, children, store: Storage.current().store }
      },
    }),
  )
  const archive = path.join(directory.path, "sessions.ndjson")
  await StoragePortable.exportFile(native.store, archive, {
    transform: (entry) => (entry.type === "record" && entry.key[0] === "sessions" ? entry : undefined),
  })
  await using target = await testRuntime()
  await target.run(async () => {
    const store = Storage.current().store
    let entered = false
    await StoragePortable.importFile(store, archive, {
      afterImport: async (tx) => {
        entered = true
        expect(Storage.inWriteTransaction()).toBe(false)
        await Session.rebuildStorageIndexes(Storage.current().store, tx)
      },
    })
    expect(entered).toBe(true)
    const page = await Index.page(native.parent.scope.id, native.parent.id, { limit: 1 })
    expect(page.total).toBe(1)
    expect(page.items.map((entry) => entry.sessionID)).toEqual([native.children[0]])
    expect(JSON.stringify(page)).not.toContain("Private input")
    expect(JSON.stringify(page)).not.toContain(native.children[1])
    const before = await Storage.read(Index.key(native.parent.scope.id, native.parent.id))
    const original = new Error("Abort after native index rebuilding")
    await expect(
      StoragePortable.importFile(store, archive, {
        accept: async (entry, tx) => entry.type === "record" && (await tx.readMany([entry.key]))[0] === undefined,
        afterImport: async (tx) => {
          await Session.rebuildStorageIndexes(Storage.current().store, tx)
          await tx.write(["portable-rebuild-rollback"], { attempted: true })
          throw original
        },
      }),
    ).rejects.toBe(original)
    expect(await Storage.read(Index.key(native.parent.scope.id, native.parent.id))).toEqual(before)
    expect(await Storage.readMany([["portable-rebuild-rollback"]])).toEqual([undefined])
    expect((await Index.page(native.parent.scope.id, native.parent.id, { limit: 1 })).items).toEqual(page.items)
    expect((await Session.get(native.children[0])).cortex?.visibility).toBe("visible")
    expect((await Session.get(native.children[1])).cortex?.visibility).toBe("hidden")
  })
}, 15000)

test("native index rebuilding rejects a foreign Store's real writer even when that foreign namespace has no Sessions", async () => {
  await using directory = await tmpdir()
  await using runtime = await testRuntime()
  const foreign = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "foreign",
    filename: path.join(directory.path, "foreign.sqlite"),
  })
  try {
    await foreign.write(["foreign-sentinel"], { retained: true })
    await runtime.run(async () => {
      await expect(
        foreign.transaction((tx) => Session.rebuildStorageIndexes(Storage.current().store, tx)),
      ).rejects.toThrow()
    })
    expect(await foreign.read(["foreign-sentinel"])).toEqual({ retained: true })
    expect(await foreign.query({ prefix: ["session_cortex_index"], limit: 1 })).toEqual([])
  } finally {
    await foreign.close()
  }
})
