import { afterAll, expect, test } from "bun:test"
import { ContextUsageSchema } from "../../src/session/context-usage-schema"
import { migrateContextUsage, upgradeContextUsage } from "../../src/session/context-usage-migration"
import { upgradeImportedRecord } from "../../src/migration/import"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const legacy = () => ({
  version: 1,
  modelID: "model",
  providerID: "provider",
  totalInput: 12,
  contextLimit: 100,
  categories: Object.fromEntries(
    ["conversation", "toolActivity", "filesReferences", "instructions"].map((key) => [
      key,
      { estimatedTokens: 2, attributedTokens: 2, items: 1 },
    ]),
  ),
  overhead: { attributedTokens: 4 },
  estimator: { kind: "bounded-utf8", sampledCharacters: 32, truncated: false },
  reconciliation: { mode: "residual", factor: 1 },
  capturedAt: 42,
})

test("migration preserves historical aggregates without inventing fine attribution", () => {
  const value = { role: "assistant", contextUsage: legacy(), annotation: "retained" }
  expect(upgradeContextUsage(value)).toBe(true)
  const snapshot = ContextUsageSchema.parse(value.contextUsage)
  expect(snapshot.categories.map((entry) => entry.category)).toEqual([
    "legacyConversation",
    "legacyTools",
    "attachments",
    "legacyInstructions",
  ])
  expect(snapshot.categories.every((entry) => entry.precision === "legacy")).toBe(true)
  expect(
    snapshot.categories.reduce((sum, entry) => sum + entry.attributedTokens, snapshot.overhead.attributedTokens),
  ).toBe(12)
  expect(value.annotation).toBe("retained")
  expect(upgradeContextUsage(value)).toBe(false)
  expect(upgradeContextUsage({ role: "assistant" })).toBe(false)
})

test("owner migration and import converge while preserving another session", () =>
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
        const value = { id, sessionID: session.id, role: "assistant", contextUsage: legacy(), annotation: "retained" }
        await Storage.write(key, value)
        await Storage.write(foreign, { ...value, sessionID: other.id })
        await migrateContextUsage({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        await migrateContextUsage({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        expect((await Storage.read<typeof value>(key)).contextUsage.version).toBe(2)
        expect((await Storage.read<typeof value>(foreign)).contextUsage.version).toBe(1)
        const imported = structuredClone(value)
        const upgraded = upgradeImportedRecord(key, imported) as typeof value
        expect(upgraded.contextUsage.version).toBe(2)
        expect(imported.contextUsage.version).toBe(1)
      },
    })
  }))
