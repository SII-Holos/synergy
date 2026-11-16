import { afterAll, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { NotFoundError } from "../../src/storage/errors"
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

test.skipIf(!storageTestBackends().includes("postgres"))(
  "postgres format 2 tree batch artifact plans stay within selected owners",
  () =>
    runtime.run(() =>
      fixture("postgres", 2, async (store) => {
        interface Plan {
          "Node Type": string
          "Relation Name"?: string
          "Index Name"?: string
          "Index Cond"?: string
          "Actual Rows"?: number
          "Actual Loops"?: number
          "Rows Removed by Filter"?: number
          "Rows Removed by Index Recheck"?: number
          Plans?: Plan[]
        }
        const node: z.ZodType<Plan> = z.lazy(() =>
          z.looseObject({
            "Node Type": z.string(),
            "Relation Name": z.string().optional(),
            "Index Name": z.string().optional(),
            "Index Cond": z.string().optional(),
            "Actual Rows": z.number().nonnegative().optional(),
            "Actual Loops": z.number().nonnegative().optional(),
            "Rows Removed by Filter": z.number().nonnegative().optional(),
            "Rows Removed by Index Recheck": z.number().nonnegative().optional(),
            Plans: z.array(node).optional(),
          }),
        )
        function parsePlan(rows: SqlRow[]) {
          expect(rows).toHaveLength(1)
          const raw = rows[0]["QUERY PLAN"]
          const value = typeof raw === "string" ? JSON.parse(raw) : raw
          return {
            raw: value,
            plan: z
              .array(z.object({ Plan: node }))
              .length(1)
              .parse(value)[0].Plan,
          }
        }
        const owner = ["sessions", "plan-scope", "selected"]
        const prefixes = Array.from({ length: 32 }, (_, index) => [
          ...owner,
          "part_field_sources",
          index === 31 ? 'p%_!"quoted' : `part-${String(index).padStart(3, "0")}`,
        ])
        const selected = prefixes.map((prefix) => [...prefix, "binary"])
        const records = prefixes.slice(0, -1).map((prefix) => [...prefix, "header"])
        const adjacent = Array.from({ length: 96 }, (_, index) => [
          ...owner,
          "part_field_sources",
          `part-000-neighbor-${index}`,
          "binary",
        ])
        const unrelated = Array.from({ length: 8192 }, (_, index) => [
          "sessions",
          "plan-scope",
          `unrelated-${Math.floor(index / 32)}`,
          "part_field_sources",
          String(index % 32),
          "binary",
        ])
        const ownRows = selected.length + adjacent.length
        function work(plan: Plan) {
          const all: Plan[] = []
          const visit = (value: Plan) => {
            all.push(value)
            value.Plans?.forEach(visit)
          }
          visit(plan)
          const scans = all.filter(
            (value) => value["Relation Name"] === "storage_artifacts" && value["Node Type"].includes("Scan"),
          )
          const indexed = (value: Plan): boolean =>
            /\b(?:owner_key|key_text)\b/.test(value["Index Cond"] ?? "") || (value.Plans ?? []).some(indexed)
          const candidateVisits = (value: Plan) => {
            if (value["Actual Rows"] === undefined || value["Actual Loops"] === undefined)
              throw new Error("Original analyzed artifact scan has no actual work counters")
            return (
              ((value["Actual Rows"] ?? 0) +
                (value["Rows Removed by Filter"] ?? 0) +
                (value["Rows Removed by Index Recheck"] ?? 0)) *
              value["Actual Loops"]
            )
          }
          const indexScans = all.filter(
            (value) => value["Index Name"]?.startsWith("storage_artifacts") && value["Node Type"].includes("Scan"),
          )
          const visits = scans.reduce((sum, value) => sum + candidateVisits(value), 0)
          const allowance = scans.reduce((sum, value) => sum + 3 * (value["Actual Loops"] ?? 0), 0)
          const addressed =
            scans.length > 0 && scans.every((value) => !value["Node Type"].includes("Seq Scan") && indexed(value))
          const indexScanCandidates = indexScans.reduce((sum, value) => sum + candidateVisits(value), 0)
          const indexAllowance = indexScans.reduce((sum, value) => sum + 3 * (value["Actual Loops"] ?? 0), 0)
          return {
            addressed,
            visits,
            allowance,
            indexScanCandidates,
            indexAllowance,
            qualifies: addressed && visits <= ownRows + allowance,
            nodeTypes: scans.map((value) => value["Node Type"]),
          }
        }
        await fixture("postgres", 2, async (foreign) => {
          const foreignKeys = [...selected, ...adjacent]
          await store.transaction(async (tx) => {
            await tx.writeMany(records.map((key) => ({ key, value: { retained: true } })))
            await tx.writeArtifacts([...selected, ...adjacent, ...unrelated].map((key) => ({ key, location })))
          })
          await foreign.transaction((tx) => tx.writeArtifacts(foreignKeys.map((key) => ({ key, location }))))
          const beforeRevisions = await store.snapshot((tx) => tx.revisions(records))
          const settings = await store.transaction(async (tx) => {
            await tx.raw.query("ANALYZE storage_artifacts")
            const [row] = await tx.raw.query(
              "SELECT version() AS version, datcollate AS collation, current_setting('enable_seqscan') AS enable_seqscan FROM pg_database WHERE datname = current_database()",
            )
            return row
          })
          expect(settings.enable_seqscan).toBe("on")
          const namespaceRows = await store.snapshot((tx) =>
            tx.raw.query("SELECT COUNT(*) AS count FROM storage_artifacts WHERE namespace = ?", [
              store.options.namespace,
            ]),
          )
          expect(Number(namespaceRows[0].count)).toBe(ownRows + unrelated.length)
          const negative = await store.snapshot(async (tx) =>
            parsePlan(
              await tx.raw.query(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT key_text, pack FROM storage_artifacts WHERE namespace = ?",
                [store.options.namespace],
              ),
            ),
          )
          const negativeWork = work(negative.plan)
          expect(negativeWork.qualifies).toBe(false)
          expect(negativeWork.visits).toBeGreaterThan(ownRows)
          const plans: Array<{
            kind: "gc" | "delete"
            statement: string
            parameters: SqlValue[]
            raw: unknown
            metrics: ReturnType<typeof work>
            forwarded: boolean
          }> = []
          await store.transaction(async (tx) => {
            const connection = tx.raw
            const query = connection.query
            using observed = spyOn(connection, "query").mockImplementation(
              async <Row extends SqlRow = SqlRow>(
                statement: string,
                values: SqlValue[] = [],
                options?: SqlQueryOptions,
              ) => {
                const kind = statement.startsWith("INSERT INTO storage_artifact_gc")
                  ? "gc"
                  : statement.startsWith("DELETE FROM storage_artifacts WHERE")
                    ? "delete"
                    : undefined
                if (!kind) return query<Row>(statement, values, options)
                const originalValues = values.slice()
                await query("SAVEPOINT artifact_batch_plan")
                const probed = await query(
                  "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement,
                  values,
                  options,
                ).then(
                  (rows) => ({ kind: "resolved" as const, rows }),
                  (error: unknown) => ({ kind: "rejected" as const, error }),
                )
                const errors: unknown[] = probed.kind === "rejected" ? [probed.error] : []
                for (const cleanup of [
                  "ROLLBACK TO SAVEPOINT artifact_batch_plan",
                  "RELEASE SAVEPOINT artifact_batch_plan",
                ]) {
                  try {
                    await query(cleanup)
                  } catch (error) {
                    if (!errors.includes(error)) errors.push(error)
                  }
                }
                if (errors.length === 1) throw errors[0]
                if (errors.length > 1)
                  throw new AggregateError(errors, "Original artifact plan probe and its cleanup failed")
                if (probed.kind !== "resolved") throw new Error("Original artifact plan did not resolve")
                const value = parsePlan(probed.rows)
                const metrics = work(value.plan)
                expect(metrics.addressed).toBe(true)
                expect(metrics.visits).toBeGreaterThanOrEqual(selected.length)
                expect(metrics.visits).toBeLessThanOrEqual(ownRows + metrics.allowance)
                expect(metrics.indexScanCandidates).toBeLessThanOrEqual(
                  ownRows * prefixes.length + metrics.indexAllowance,
                )
                expect(values).toEqual(originalValues)
                const plan: (typeof plans)[number] = {
                  kind,
                  statement,
                  parameters: originalValues,
                  raw: value.raw,
                  metrics,
                  forwarded: false,
                }
                plans.push(plan)
                const rows = await query<Row>(statement, values, options)
                plan.forwarded = true
                return rows
              },
            )
            await tx.removeTrees(prefixes)
            expect(plans.map((plan) => plan.kind)).toEqual(["gc", "delete"])
            expect(plans.every((plan) => plan.forwarded)).toBe(true)
          })
          expect(await store.readMany(records)).toEqual(records.map(() => undefined))
          const tombstones = await store.snapshot((tx) =>
            tx.raw.query(
              "SELECT key_text, body, revision FROM storage_records WHERE namespace = ? AND key_text IN (" +
                records.map(() => "?").join(", ") +
                ")",
              [store.options.namespace, ...records.map((key) => JSON.stringify(key))],
            ),
          )
          expect(tombstones).toHaveLength(records.length)
          for (const [index, key] of records.entries()) {
            const row = tombstones.find((value) => value.key_text === JSON.stringify(key))
            expect(row?.body).toBeNull()
            const previous = beforeRevisions[index]
            if (previous === undefined) throw new Error("Original selected record has no committed revision")
            expect(BigInt(String(row!.revision))).toBe(previous + 1n)
          }
          for (const key of selected) {
            const outcome = await failure(store.snapshot((tx) => tx.artifact(key)))
            expect(outcome.kind).toBe("rejected")
            if (outcome.kind === "rejected") expect(outcome.error).toBeInstanceOf(NotFoundError)
          }
          expect(await store.snapshot((tx) => Promise.all(adjacent.map((key) => tx.artifact(key))))).toEqual(
            adjacent.map(() => location),
          )
          expect(await foreign.snapshot((tx) => Promise.all(foreignKeys.map((key) => tx.artifact(key))))).toEqual(
            foreignKeys.map(() => location),
          )
          const survivors = await store.snapshot((tx) =>
            tx.raw.query("SELECT COUNT(*) AS count FROM storage_artifacts WHERE namespace = ?", [
              store.options.namespace,
            ]),
          )
          expect(Number(survivors[0].count)).toBe(adjacent.length + unrelated.length)
          expect(await store.snapshot((tx) => tx.artifactGarbage())).toEqual([{ pack: location.pack, used: true }])
          const report = {
            format: "postgres-tree-artifact-plan-v1",
            backend: "postgres",
            settings,
            seed: {
              selected: selected.length,
              selectedOwner: ownRows,
              unrelatedSameNamespace: unrelated.length,
              foreignNamespace: foreignKeys.length,
              prefixes: prefixes.length,
            },
            negative: { raw: negative.raw, metrics: negativeWork },
            plans,
            ordinaryOperationCompleted: true,
          }
          const output = process.env.SYNERGY_TEST_PG_TREE_BATCH_PLAN_REPORT
          if (output) await Bun.write(output, JSON.stringify(report, null, 2) + "\n")
          console.log(
            "PG_TREE_BATCH_ARTIFACT_WORK",
            JSON.stringify({
              seed: report.seed,
              negative: negativeWork,
              plans: plans.map((plan) => ({ kind: plan.kind, ...plan.metrics, forwarded: plan.forwarded })),
              ordinaryOperationCompleted: true,
            }),
          )
        })
      }),
    ),
)
