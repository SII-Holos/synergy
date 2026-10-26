import { afterAll, expect, test } from "bun:test"
import { migrateCompactionCoverage, upgradeCompactionCoverage } from "../../src/session/compaction-migration"
import { upgradeImportedRecord } from "../../src/migration/import"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
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
