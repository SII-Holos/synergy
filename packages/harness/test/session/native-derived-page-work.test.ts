import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { RuntimeContext } from "../../src/lifecycle/context"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { StoreTransaction } from "../../src/storage/transactional-store"
import { SqliteWorkerClient } from "../../src/storage/sqlite-worker-client"
import { SessionAttachmentIndex } from "../../src/session/attachment-index"
import { SessionPartFieldSource } from "../../src/session/part-field-source"

type Domain = "attachment_index" | "part_field_sources"
type HistoricalPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  retainedFuture: { ordinal: number }
}
type History = {
  scopeID: string
  sessionID: string
  messageID: string
  parts: HistoricalPart[]
  keys: string[][]
  revisions: (bigint | undefined)[]
}
const migration = (domain: Domain) =>
  domain === "attachment_index" ? SessionAttachmentIndex.migration : SessionPartFieldSource.migration
const header = (domain: Domain, key: string[]) => [...key.slice(0, 3), domain, key[4], key[6], "header"]
async function coldHistory(body: (history: History) => Promise<void>) {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          rootID: messageID,
          role: "user",
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: 1 },
        })
        const parts: HistoricalPart[] = Array.from({ length: 33 }, (_, index) => ({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID,
          type: "text",
          text: `Original historical bytes ${index}`,
          retainedFuture: { ordinal: index },
        }))
        const keys = parts.map((part) =>
          StoragePath.messagePart(
            Identifier.asScopeID(session.scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID(messageID),
            Identifier.asPartID(part.id),
          ),
        )
        await Storage.transaction((tx) => tx.writeMany(parts.map((value, index) => ({ key: keys[index], value }))))
        await body({
          scopeID: session.scope.id,
          sessionID: session.id,
          messageID,
          parts,
          keys,
          revisions: await Storage.revisions(keys),
        })
      },
    }),
  )
}
async function originalResult(domain: Domain, key: string[], expected: string) {
  if (domain === "attachment_index") {
    expect(await SessionAttachmentIndex.page(key, { limit: 32 })).toMatchObject({ total: 0, items: [] })
    return
  }
  const selected = await SessionPartFieldSource.get(key)
  const text = selected.fields.find((field) => field.field === "text")
  if (!text || text.kind !== "chunks") throw new Error("Original historical text chunks are missing")
  const bytes = await SessionPartFieldSource.range(key, text, 0, text.bytes)
  if (!bytes) throw new Error("Original historical text bytes are missing")
  expect(Buffer.from(bytes).toString()).toBe(expected)
}
for (const domain of ["attachment_index", "part_field_sources"] as const) {
  test(
    `${domain} migration clears a cold 33-Part history through bounded native pages`,
    () =>
      coldHistory(async (value) => {
        const sqlOwner = RuntimeContext.current()
        const request = SqliteWorkerClient.prototype.request
        let gcIntents = 0
        let artifactDeletes = 0
        await (async () => {
          using observed = spyOn(SqliteWorkerClient.prototype, "request").mockImplementation(function (
            this: SqliteWorkerClient,
            input: Parameters<typeof request>[0],
          ) {
            if (
              RuntimeContext.tryCurrent() === sqlOwner &&
              input.action === "query" &&
              input.values?.some((item) => typeof item === "string" && item.includes(JSON.stringify(domain)))
            ) {
              if (/^INSERT INTO storage_artifact_gc\b/.test(input.statement ?? "")) gcIntents++
              if (/^DELETE FROM storage_artifacts\b/.test(input.statement ?? "")) artifactDeletes++
            }
            return request.call(this, input)
          })
          await migration(domain).upSession!(value, () => {})
        })()
        const headers = await Storage.readMany<{ revision: string }>(value.keys.map((key) => header(domain, key)))
        expect(headers.map((item) => item?.revision)).toEqual(value.revisions.map(String))
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
        expect(await Storage.revisions(value.keys)).toEqual(value.revisions)
        await originalResult(domain, value.keys.at(-1)!, value.parts.at(-1)!.text)
        expect(gcIntents).toBeGreaterThan(0)
        expect(artifactDeletes).toBeGreaterThan(0)
        expect(gcIntents).toBeLessThanOrEqual(2)
        expect(artifactDeletes).toBeLessThanOrEqual(2)
      }),
    30_000,
  )

  test(
    `${domain} migration retains committed earlier pages and retries a rejected canonical suffix`,
    () =>
      coldHistory(async (value) => {
        const last = value.keys.at(-1)!
        const bad = { ...value.parts.at(-1)!, id: Identifier.ascending("part") }
        await Storage.write(last, bad)
        const failed = await migration(domain).upSession!(value, () => {}).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        expect(failed.kind).toBe("rejected")
        if (failed.kind === "rejected") expect(failed.error).toMatchObject({ name: "StorageIntegrityError" })
        const firstHeaders = await Storage.readMany<{ revision: string }>(
          value.keys.slice(0, 32).map((key) => header(domain, key)),
        )
        expect(firstHeaders.map((item) => item?.revision)).toEqual(value.revisions.slice(0, 32).map(String))
        expect(await Storage.readMany([header(domain, last)])).toEqual([undefined])
        expect(await Storage.read(last)).toEqual(bad)
        await Storage.write(last, value.parts.at(-1)!)
        const versioned = StoreTransaction.prototype.versioned
        const canonical = new Set(value.keys.map((key) => JSON.stringify(key)))
        let reads = 0
        await (async () => {
          using observed = spyOn(StoreTransaction.prototype, "versioned").mockImplementation(async function <T>(
            this: StoreTransaction,
            key: string[],
          ) {
            if (canonical.has(JSON.stringify(key))) reads++
            return (versioned<T>).call(this, key)
          })
          await migration(domain).upSession!(value, () => {})
        })()
        expect(reads).toBe(1)
        expect(await Storage.readMany(value.keys)).toEqual(value.parts)
        expect(await Storage.readMany(value.keys.slice(0, 32).map((key) => header(domain, key)))).toEqual(firstHeaders)
        await originalResult(domain, last, value.parts.at(-1)!.text)
      }),
    30_000,
  )

  test(
    `${domain} migration captures the current canonical revision after its original preparation snapshot`,
    () =>
      coldHistory(async (value) => {
        const revisions = StoreTransaction.prototype.revisions
        const canonical = new Set(value.keys.map((key) => JSON.stringify(key)))
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let held = false
        using observed = spyOn(StoreTransaction.prototype, "revisions").mockImplementation(async function (
          this: StoreTransaction,
          keys: string[][],
        ) {
          const result = await revisions.call(this, keys)
          if (!held && keys.length === 32 && keys.every((key) => canonical.has(JSON.stringify(key)))) {
            held = true
            entered.resolve()
            await release.promise
          }
          return result
        })
        const pending = migration(domain).upSession!(value, () => {}).then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        )
        try {
          const reached = await Promise.race([entered.promise.then(() => ({ kind: "held" as const })), pending])
          if (reached.kind === "failed") throw reached.error
          if (reached.kind !== "held") throw new Error("Original preparation snapshot was not observed")
          value.parts[0] = { ...value.parts[0], text: "Current original revision after snapshot" }
          await Storage.write(value.keys[0], value.parts[0])
        } finally {
          release.resolve()
          await pending
        }
        const completed = await pending
        if (completed.kind === "failed") throw completed.error
        expect(held).toBe(true)
        const [revision] = await Storage.revisions([value.keys[0]])
        expect(await Storage.read<{ revision: string }>(header(domain, value.keys[0]))).toMatchObject({
          revision: String(revision),
        })
        await originalResult(domain, value.keys[0], value.parts[0].text)
      }),
    30_000,
  )
}
