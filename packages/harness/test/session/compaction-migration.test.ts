import { afterAll, expect, test } from "bun:test"
import { migrateCompactionCoverage, upgradeCompactionCoverage } from "../../src/session/compaction-migration"
import { upgradeImportedRecord } from "../../src/migration/import"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
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
