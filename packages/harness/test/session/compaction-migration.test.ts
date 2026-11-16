import { afterAll, expect, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { migrateCompactionCoverage, upgradeCompactionCoverage } from "../../src/session/compaction-migration"
import { upgradeImportedRecord } from "../../src/migration/import"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { prepareSessionMigrations } from "../../src/migration"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("only committed legacy summaries gain their existing filtering cursor", () => {
  const key = ["sessions", "scope", "session", "messages", "summary", "info"]
  const value = {
    id: "summary",
    role: "assistant",
    summary: true,
    finish: "stop",
    time: { created: 100 },
    metadata: { unrelated: "preserved" },
  }
  expect(upgradeCompactionCoverage(key, value)).toBe(true)
  expect(value).toMatchObject({
    compaction: { coveredThrough: { created: 100, messageID: "summary" } },
    metadata: { unrelated: "preserved" },
  })
  expect(upgradeCompactionCoverage(key, value)).toBe(false)
  expect(upgradeCompactionCoverage(key, { ...value, compaction: undefined, finish: undefined })).toBe(false)
  expect(upgradeCompactionCoverage(key, { ...value, compaction: undefined, summary: false })).toBe(false)
})

test("owner migration and portable import converge without touching another session", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const other = await Session.create({})
        const id = Identifier.ascending("message")
        const key = StoragePath.messageInfo(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          id,
        )
        const foreign = StoragePath.messageInfo(
          Identifier.asScopeID(other.scope.id),
          Identifier.asSessionID(other.id),
          id,
        )
        const value = {
          id,
          role: "assistant",
          summary: true,
          finish: "stop",
          sessionID: session.id,
          time: { created: 100 },
          metadata: { annotation: "retained" },
        }
        await Storage.write(key, value)
        await Storage.write(foreign, { ...value, sessionID: other.id })
        await migrateCompactionCoverage({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        await migrateCompactionCoverage({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        const expected = { ...value, compaction: { coveredThrough: { created: 100, messageID: id } } }
        expect(await Storage.read(key)).toEqual(expected)
        expect(await Storage.read(foreign)).toEqual({ ...value, sessionID: other.id })
        expect(upgradeImportedRecord(key, structuredClone(value))).toMatchObject(expected)
        expect(value).not.toHaveProperty("compaction")
      },
    })
  }))

test("central coverage migration preserves legacy history and its receipt across restart", async () => {
  await using home = await tmpdir()
  let sessionID = ""
  let summaryID = ""
  let rawIDs: string[] = []
  let workingIDs: string[] = []
  let completed: unknown
  const receipt = () => ["sessions", "home", sessionID, "migrations", "session", "20261026-session-compaction-coverage"]
  {
    await using fresh = await testRuntime({ home: home.path })
    await fresh.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          sessionID = (await Session.create({ workspace: null })).id
          await prepareSessionMigrations({ scopeID: "home", sessionID })
          expect((await Storage.read<{ completed: number }>(receipt())).completed).toBeGreaterThan(0)
          expect(await SessionHistory.modelMessages({ sessionID })).toEqual([])
          const user = async (created: number) =>
            Session.updateMessage({
              id: Identifier.ascending("message"),
              sessionID,
              role: "user",
              time: { created },
              agent: "fixture",
              model: { providerID: "fixture", modelID: "fixture" },
            })
          const old = await user(1)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID: old.id,
            type: "text",
            text: "A restriction from before the legacy summary.",
          })
          const boundary = await user(2)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID: boundary.id,
            type: "compaction",
            auto: false,
          })
          summaryID = Identifier.ascending("message")
          await Session.updateMessage({
            id: summaryID,
            sessionID,
            role: "assistant",
            parentID: boundary.id,
            rootID: boundary.id,
            time: { created: 3, completed: 3 },
            agent: "compaction",
            mode: "compaction",
            modelID: "fixture",
            providerID: "fixture",
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            summary: true,
            finish: "stop",
          })
          const tail = await user(4)
          rawIDs = [old.id, boundary.id, summaryID, tail.id]
          workingIDs = [boundary.id, summaryID, tail.id]
          expect((await MessageV2.get({ sessionID, messageID: summaryID })).info).not.toHaveProperty("compaction")
          await Storage.remove(receipt())
          await prepareSessionMigrations({ scopeID: "home", sessionID })
          completed = await Storage.read(receipt())
          expect(completed).toMatchObject({ completed: expect.any(Number) })
          expect((await MessageV2.get({ sessionID, messageID: summaryID })).info).toMatchObject({
            compaction: { coveredThrough: { created: 3, messageID: summaryID } },
          })
          expect((await SessionHistory.messages({ sessionID })).map((message) => message.info.id)).toEqual(rawIDs)
          expect((await SessionHistory.modelMessages({ sessionID })).map((message) => message.info.id)).toEqual(
            workingIDs,
          )
        },
      }),
    )
  }
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await prepareSessionMigrations({ scopeID: "home", sessionID })
        expect(await Storage.read(receipt())).toEqual(completed)
        expect((await MessageV2.get({ sessionID, messageID: summaryID })).info).toMatchObject({
          compaction: { coveredThrough: { created: 3, messageID: summaryID } },
        })
        expect((await SessionHistory.messages({ sessionID })).map((message) => message.info.id)).toEqual(rawIDs)
        expect((await SessionHistory.modelMessages({ sessionID })).map((message) => message.info.id)).toEqual(
          workingIDs,
        )
      },
    }),
  )
})

test("owner coverage preparation uses bounded fresh writers while preserving ordinary headers and existing coverage", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const owner = { scopeID: Identifier.asScopeID(session.scope.id), sessionID: Identifier.asSessionID(session.id) }
        const ids = Array.from({ length: 257 }, () => Identifier.ascending("message"))
        const keys = ids.map((id) => StoragePath.messageInfo(owner.scopeID, owner.sessionID, id))
        const values = ids.map((id, index) => ({
          id,
          sessionID: session.id,
          role: index % 64 === 0 ? "assistant" : "user",
          time: { created: index },
          metadata: { original: index },
          ...(index % 64 === 0 ? { summary: true, finish: "stop" } : {}),
          ...(index === 128 ? { compaction: { coveredThrough: { created: 7, messageID: ids[0] } } } : {}),
        }))
        await Storage.transaction((tx) => tx.writeMany(values.map((value, index) => ({ key: keys[index], value }))))
        const before = await Storage.revisions(keys)
        let writers = 0
        let windows: number[] = []
        const migration = new AsyncLocalStorage<boolean>()
        const store = Storage.current().store
        const transaction = store.transaction.bind(store)
        {
          using _writes = spyOn(store, "transaction").mockImplementation(
            <T>(
              body: Parameters<typeof store.transaction<T>>[0],
              options?: Parameters<typeof store.transaction<T>>[1],
            ) => {
              if (migration.getStore()) writers++
              return transaction(body, options)
            },
          )
          using reads = spyOn(StoreTransaction.prototype, "readMany")
          using bodies = spyOn(Storage, "readBinary")
          await migration.run(true, () => migrateCompactionCoverage(owner, () => {}))
          windows = reads.mock.calls
            .map(
              ([selected]) =>
                selected.filter((key) => key[0] === "sessions" && key[2] === session.id && key[3] === "messages")
                  .length,
            )
            .filter((count) => count > 0)
          expect(bodies).not.toHaveBeenCalled()
        }
        expect(writers).toBeGreaterThan(0)
        expect(writers).toBeLessThanOrEqual(Math.ceil(ids.length / 128))
        expect(windows.reduce((sum, count) => sum + count, 0)).toBe(ids.length)
        expect(windows.every((count) => count <= 128)).toBe(true)
        const expected = values.map((value, index) =>
          index % 64 === 0 && index !== 128
            ? { ...value, compaction: { coveredThrough: { created: index, messageID: value.id } } }
            : value,
        )
        expect(await Storage.readMany(keys)).toEqual(expected)
        const after = await Storage.revisions(keys)
        expect(after.filter((_revision, index) => index % 64 !== 0 || index === 128)).toEqual(
          before.filter((_revision, index) => index % 64 !== 0 || index === 128),
        )
        await migrateCompactionCoverage(owner, () => {})
        expect(await Storage.revisions(keys)).toEqual(after)
      },
    }),
  ))

test("owner coverage preparation rereads the original header after another writer commits current coverage", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const owner = { scopeID: Identifier.asScopeID(session.scope.id), sessionID: Identifier.asSessionID(session.id) }
        const id = Identifier.ascending("message")
        const key = StoragePath.messageInfo(owner.scopeID, owner.sessionID, id)
        const original = {
          id,
          sessionID: session.id,
          role: "assistant",
          summary: true,
          finish: "stop",
          time: { created: 99 },
        }
        await Storage.write(key, original)
        const entered = Promise.withResolvers<void>()
        const released = Promise.withResolvers<void>()
        const store = Storage.current().store
        const transaction = store.transaction.bind(store)
        const migration = new AsyncLocalStorage<boolean>()
        let held = false
        using _barrier = spyOn(store, "transaction").mockImplementation(
          <T>(
            body: Parameters<typeof store.transaction<T>>[0],
            options?: Parameters<typeof store.transaction<T>>[1],
          ) => {
            if (!migration.getStore() || held) return transaction(body, options)
            held = true
            entered.resolve()
            return released.promise.then(() => transaction(body, options))
          },
        )
        const migrating = migration.run(true, () => migrateCompactionCoverage(owner, () => {}))
        void migrating.catch(() => {})
        try {
          await entered.promise
          const current = {
            ...original,
            metadata: { current: "accepted before the original migration writer" },
            compaction: { coveredThrough: { created: 7, messageID: id } },
          }
          await Storage.write(key, current)
          const revisions = await Storage.revisions([key])
          released.resolve()
          await migrating
          expect(await Storage.read(key)).toEqual(current)
          expect(await Storage.revisions([key])).toEqual(revisions)
        } finally {
          released.resolve()
          await migrating
        }
      },
    }),
  ))
