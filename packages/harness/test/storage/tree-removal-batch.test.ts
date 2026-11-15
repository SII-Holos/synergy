import { afterAll, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestBackends } from "../support/storage-backends"
import { createV2Store } from "./format-v3-fixture"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())
const location = {
  pack: "00000000-0000-0000-0000-000000000000.pack",
  codec: "raw" as const,
  blockOffset: 0,
  blockBytes: 1,
  decodedBytes: 1,
  offset: 0,
  size: 1,
  sha256: "0".repeat(64),
}
async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  )
}
async function fixture(
  backend: "sqlite" | "postgres",
  format: number,
  body: (store: TransactionalStore) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "tree-removal-batch-"))
  const filename = path.join(root, "agent.sqlite")
  const namespace = crypto.randomUUID()
  if (backend === "sqlite" && format === 2) createV2Store({ filename, namespace, records: [] })
  const store = await TransactionalStore.open(
    backend === "sqlite"
      ? { backend, filename, namespace }
      : { backend, namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! },
  )
  try {
    await body(store)
  } finally {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}
for (const backend of storageTestBackends()) {
  for (const format of backend === "sqlite" ? [2, 3] : [2]) {
    test(`${backend} format ${format} tree batches preserve atomic tombstones, orphan artifacts and retained references`, () =>
      runtime.run(() =>
        fixture(backend, format, async (store) => {
          const first = ["trees", "part"]
          const second = ["trees", 'p%_!"quoted', "child"]
          const orphan = ["trees", "orphan-without-nodes"]
          const survivor = ["trees", "part-neighbor", "record"]
          const records = [
            [...first, "record"],
            [...second, "record"],
          ]
          const removedArtifacts = [
            [...first, "binary"],
            [...orphan, "binary"],
          ]
          const keptArtifact = [...survivor, "binary"]
          const caseRecord = ["trees", "PART", "record"]
          const caseArtifact = [...caseRecord, "binary"]
          const allArtifacts = [...removedArtifacts, keptArtifact, caseArtifact]
          await store.transaction(async (tx) => {
            await tx.writeMany([...records, survivor, caseRecord].map((key, index) => ({ key, value: { index } })))
            await tx.writeArtifacts(allArtifacts.map((key) => ({ key, location })))
            const physical = backend === "postgres" || format === 2
            await tx.raw.query(
              "INSERT INTO storage_artifacts(namespace, key_text, owner_key, location" +
                (physical ? ", pack" : "") +
                ") SELECT ?, key_text, owner_key, location" +
                (physical ? ", pack" : "") +
                " FROM storage_artifacts WHERE namespace = ?",
              [store.options.namespace + "-foreign", store.options.namespace],
            )
          })
          expect(await store.scan(orphan)).toEqual([])
          const before = await store.readMany([...records, survivor, caseRecord])
          const revisions = await store.snapshot(async (tx) => Promise.all(records.map((key) => tx.versioned(key))))
          const rollback = new Error("Original page rollback")
          const failed = await failure(
            store.transaction(async (tx) => {
              await tx.removeTrees([first, second, orphan, first, [...first, "record"]])
              expect(await tx.readMany(records)).toEqual([undefined, undefined])
              throw rollback
            }),
          )
          expect(failed).toEqual({ kind: "rejected", error: rollback })
          expect(await store.readMany([...records, survivor, caseRecord])).toEqual(before)
          expect(await store.snapshot((tx) => Promise.all(allArtifacts.map((key) => tx.artifact(key))))).toEqual(
            allArtifacts.map(() => location),
          )
          expect(await store.snapshot((tx) => tx.artifactGarbage())).toEqual([])
          const seen: Array<{ keys: string[][]; tree: boolean }> = []
          const prefixes = [first, second, orphan, first, [...first, "record"]]
          await store.transaction(async (tx) => {
            let artifactQuery: { statement: string; values: SqlValue[] } | undefined
            const query = tx.raw.query
            using observed = spyOn(tx.raw, "query").mockImplementation(
              <Row extends SqlRow = SqlRow>(statement: string, values: SqlValue[] = [], options?: SqlQueryOptions) => {
                if (statement.startsWith("INSERT INTO storage_artifact_gc"))
                  artifactQuery = { statement, values: values.slice() }
                return query<Row>(statement, values, options)
              },
            )
            tx.guardMutations(async (keys, tree) => {
              seen.push({ keys: keys.map((key) => key.slice()), tree })
            })
            await tx.removeTrees(prefixes)
            if (backend === "sqlite") {
              if (!artifactQuery) throw new Error("Original batch artifact statement was not observed")
              initializeSqliteEngine()
              const database = new Database(store.sqliteFilename!, { readonly: true })
              const query = database.prepare<{ detail: string }, SqlValue[]>(
                "EXPLAIN QUERY PLAN " + artifactQuery.statement,
              )
              try {
                const details = query.all(...artifactQuery.values).map((row) => row.detail)
                const searches = details.filter((detail) => detail.includes("SEARCH storage_artifacts"))
                expect(searches.length).toBeGreaterThan(0)
                expect(searches.every((detail) => detail.includes("key_text"))).toBe(true)
                expect(details.some((detail) => detail.includes("SCAN storage_artifacts"))).toBe(false)
              } finally {
                query.finalize()
                database.close()
              }
            }
          })
          expect(seen).toEqual([{ keys: prefixes, tree: true }])
          expect(await store.readMany(records)).toEqual([undefined, undefined])
          expect(await store.read(survivor)).toEqual(before.at(-2))
          expect(await store.read(caseRecord)).toEqual(before.at(-1))
          expect(await store.snapshot((tx) => tx.artifact(caseArtifact))).toEqual(location)
          expect(await store.snapshot((tx) => tx.artifact(keptArtifact))).toEqual(location)
          for (const key of removedArtifacts) {
            const outcome = await failure(store.snapshot((tx) => tx.artifact(key)))
            expect(outcome.kind).toBe("rejected")
            if (outcome.kind === "rejected") expect(outcome.error).toBeInstanceOf(Error)
          }
          expect(await store.snapshot((tx) => tx.artifactGarbage())).toEqual([{ pack: location.pack, used: true }])
          const tombstones = await store.snapshot((tx) =>
            tx.raw.query(
              "SELECT key_text, body, revision FROM storage_records WHERE namespace = ? AND key_text IN (?, ?)",
              [store.options.namespace, ...records.map((key) => JSON.stringify(key))],
            ),
          )
          expect(tombstones.length).toBe(2)
          for (const [index, key] of records.entries()) {
            const row = tombstones.find((row) => row.key_text === JSON.stringify(key))
            expect(row?.body).toBeNull()
            expect(BigInt(String(row!.revision))).toBe(revisions[index].revision + 1n)
          }
          expect(await store.scan(["trees"])).toEqual(["PART", "part-neighbor"])
          const foreign = await store.snapshot((tx) =>
            tx.raw.query("SELECT COUNT(*) AS count FROM storage_artifacts WHERE namespace = ?", [
              store.options.namespace + "-foreign",
            ]),
          )
          expect(Number(foreign[0]?.count)).toBe(allArtifacts.length)
          expect((await store.verify()).issues).toEqual([])
        }),
      ))

    test(`${backend} format ${format} tree batches retain current mutation, publication and deleted-Session guards`, () =>
      runtime.run(() =>
        fixture(backend, format, async (store) => {
          const owner = ["sessions", "scope", "original", "info"]
          const first = [...owner.slice(0, 3), "derived", "a"]
          const second = [...owner.slice(0, 3), "derived", "b"]
          const records = [
            [...first, "header"],
            [...second, "header"],
          ]
          await store.transaction((tx) =>
            tx.writeMany([
              { key: owner, value: { id: "original" } },
              ...records.map((key) => ({ key, value: { retained: true } })),
            ]),
          )
          await store.transaction(async (tx) => {
            let guards = 0
            let statements = 0
            tx.guardMutations(async () => {
              guards++
            })
            const query = tx.raw.query
            using observed = spyOn(tx.raw, "query").mockImplementation(
              <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
                statements++
                return query<Row>(statement, values, options)
              },
            )
            for (const prefixes of [[first, ["invalid", ""]], [first, []], Array.from({ length: 129 }, () => first)]) {
              const invalid = await failure(tx.removeTrees(prefixes))
              expect(invalid.kind).toBe("rejected")
              if (invalid.kind === "rejected") expect(invalid.error).toMatchObject({ name: "StorageIntegrityError" })
            }
            expect(guards).toBe(0)
            expect(statements).toBe(0)
          })
          const denied = new Error("Original native mutation denied")
          expect(
            await failure(
              store.transaction(async (tx) => {
                tx.guardMutations(async (keys, tree) => {
                  expect(tree).toBe(true)
                  expect(keys).toEqual([first, second])
                  throw denied
                })
                await tx.removeTrees([first, second])
              }),
            ),
          ).toEqual({ kind: "rejected", error: denied })
          expect(await store.readMany(records)).toEqual([{ retained: true }, { retained: true }])
          await store.transaction((tx) => tx.write(["compat_pending", "original"], { pending: true }))
          const preparing = await failure(
            store.transaction(async (tx) => {
              tx.restrictToPublishedOwners()
              await tx.removeTrees([["outside"], first, second])
            }),
          )
          expect(preparing.kind).toBe("rejected")
          if (preparing.kind === "rejected") expect(preparing.error).toMatchObject({ name: "SessionPreparingError" })
          await store.transaction((tx) => tx.remove(["compat_pending", "original"]))
          const retired = await failure(
            store.transaction(async (tx) => {
              await tx.remove(owner)
              await tx.removeTrees([first, second])
              await tx.write(records[0], { delayed: true })
            }),
          )
          expect(retired.kind).toBe("rejected")
          if (retired.kind === "rejected") expect(retired.error).toMatchObject({ name: "StorageConflictError" })
          expect(await store.read(owner)).toEqual({ id: "original" })
          expect(await store.readMany(records)).toEqual([{ retained: true }, { retained: true }])
          expect(await store.snapshot((tx) => tx.artifactGarbage())).toEqual([])
        }),
      ))
  }
}
