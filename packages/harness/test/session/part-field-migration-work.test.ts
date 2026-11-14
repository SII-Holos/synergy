import { expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionPartFieldSource } from "../../src/session/part-field-source"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"

async function legacyParts(count: number) {
  const session = await Session.create({ workspace: null, environmentID: null })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "user",
    rootID: messageID,
    isRoot: true,
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
    time: { created: 1 },
  })
  const parts = Array.from({ length: count }, (_, index) => ({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID,
    type: "text" as const,
    text: index === count - 1 ? "Original 🌏 text".repeat(5000) : `Legacy field ${index} 🌏`,
    futureProducerData: { retained: index },
  }))
  const owner = { scopeID: session.scope.id, sessionID: session.id }
  const keys = parts.map((part) =>
    StoragePath.messagePart(
      Identifier.asScopeID(owner.scopeID),
      Identifier.asSessionID(owner.sessionID),
      Identifier.asMessageID(messageID),
      Identifier.asPartID(part.id),
    ),
  )
  await Storage.transaction((tx) => tx.writeMany(parts.map((value, index) => ({ key: keys[index], value }))))
  return { owner, parts, keys }
}

const sourceHeader = (key: string[]) => [...key.slice(0, 3), "part_field_sources", key[4], key[6], "header"]

test("cold native field migration uses bounded writers while decoding canonical Parts one at a time", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await legacyParts(65)
        const revisions = await Storage.revisions(value.keys)
        expect((await Storage.queryKeys({ kind: "part", ...value.owner, limit: 128 })).length).toBe(65)
        expect((await Storage.readMany(value.keys.map(sourceHeader))).every((row) => row === undefined)).toBe(true)
        let writerTransactions = 0
        let bulkBodyReads = 0
        {
          using writers = spyOn(Storage, "transaction")
          using reads = spyOn(StoreTransaction.prototype, "readMany")
          await SessionPartFieldSource.migration.upSession!(value.owner, () => {})
          writerTransactions = writers.mock.calls.length
          bulkBodyReads = reads.mock.calls.filter(([keys]) =>
            keys.some((key) => key.length === 7 && key[3] === "messages" && key[5] === "parts"),
          ).length
        }
        expect(writerTransactions).toBeGreaterThan(0)
        expect(writerTransactions).toBeLessThanOrEqual(3)
        expect(bulkBodyReads).toBe(0)
        expect(await Storage.revisions(value.keys)).toEqual(revisions)
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
        for (let index = 0; index < value.keys.length; index++) {
          const projection = await SessionPartFieldSource.get(value.keys[index])
          expect(projection.header).toMatchObject({ id: value.parts[index].id, type: "text" })
          expect(projection.revision).toBe(String(revisions[index]))
          const field = projection.fields.find((field) => field.field === "text")
          if (!field) throw new Error("The original native text field was not published")
          const chunks = await Array.fromAsync(SessionPartFieldSource.stream(value.keys[index], field))
          expect(Buffer.concat(chunks).toString("utf8")).toBe(value.parts[index].text)
        }
      },
    }),
  )
})

test("a rejected field migration page rolls back and retries without rewriting canonical Parts", async () => {
  let failingPartID: string | undefined
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("original-field-page-rejection", async (_tx, keys) => {
        if (failingPartID && keys.some((key) => key[3] === "part_field_sources" && key[5] === failingPartID))
          throw new Error("Original field migration publication rejected")
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const value = await legacyParts(40)
        const revisions = await Storage.revisions(value.keys)
        failingPartID = value.parts[36].id
        await expect(SessionPartFieldSource.migration.upSession!(value.owner, () => {})).rejects.toThrow(
          "Original field migration publication rejected",
        )
        const headers = await Storage.readMany(value.keys.map(sourceHeader))
        expect(headers.slice(0, 32).every((row) => row !== undefined)).toBe(true)
        expect(headers.slice(32).every((row) => row === undefined)).toBe(true)
        expect(await Storage.revisions(value.keys)).toEqual(revisions)
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
        failingPartID = undefined
        await SessionPartFieldSource.migration.upSession!(value.owner, () => {})
        expect((await Storage.readMany(value.keys.map(sourceHeader))).every((row) => row !== undefined)).toBe(true)
        expect(await Storage.revisions(value.keys)).toEqual(revisions)
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
      },
    }),
  )
})
