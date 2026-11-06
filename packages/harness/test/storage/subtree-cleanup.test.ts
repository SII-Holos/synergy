import { afterAll, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { TransactionalStore } from "../../src/storage/transactional-store"
import type {
  SqlConnection,
  SqlQueryOptions,
  SqlRow,
  SqlTransactionOptions,
  SqlValue,
} from "../../src/storage/sql-contract"
import { createV2Store } from "./format-v3-fixture"

const runtime = await testRuntime()
afterAll(() => runtime.close())

for (const format of [2, 3]) {
  test(`local deletion only probes addressed nodes in format ${format}`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "agent.sqlite")
      if (format === 2) createV2Store({ filename, namespace: "cleanup", records: [] })
      const store = await TransactionalStore.open({ backend: "sqlite", namespace: "cleanup", filename })
      try {
        await store.transaction((tx) =>
          tx.writeMany([
            ...Array.from({ length: 200 }, (_, index) => ({ key: ["unrelated", String(index)], value: { index } })),
            { key: ["inbox", "owner", "one"], value: { accepted: true } },
            { key: ["inbox", "owner", "two"], value: { accepted: true } },
          ]),
        )
        const transaction = SqliteDriver.prototype.transaction
        const statements: Array<{ statement: string; values: SqlValue[] }> = []
        using observed = spyOn(SqliteDriver.prototype, "transaction").mockImplementation(async function <T>(
          this: SqliteDriver,
          body: (connection: SqlConnection) => Promise<T>,
          options?: SqlTransactionOptions,
        ) {
          return (await transaction.call(
            this,
            (connection) =>
              body({
                async query<Row extends SqlRow>(
                  statement: string,
                  values: SqlValue[] = [],
                  queryOptions?: SqlQueryOptions,
                ) {
                  if (statement.includes("DELETE FROM storage_nodes")) {
                    statements.push({ statement, values })
                  }
                  return connection.query<Row>(statement, values, queryOptions)
                },
              }),
            options,
          )) as T
        })
        await store.removeTree(["missing", "order-markers"])
        await store.transaction((tx) =>
          tx.removeMany([
            ["inbox", "owner", "one"],
            ["inbox", "owner", "two"],
          ]),
        )
        const database = new Database(filename, { readonly: true })
        const plans: string[] = []
        try {
          for (const { statement, values } of statements) {
            const query = database.prepare<{ detail: string }, SqlValue[]>("EXPLAIN QUERY PLAN " + statement)
            try {
              plans.push(...query.all(...values).map((row) => row.detail))
            } finally {
              query.finalize()
            }
          }
        } finally {
          database.close()
        }
        expect(plans.length).toBeGreaterThan(0)
        expect(plans.filter((detail) => /SCAN (?:node|storage_nodes)\b/.test(detail))).toEqual([])
        expect(plans.filter((detail) => /SEARCH (?:node|storage_nodes)\b.*\(namespace=\?\)$/.test(detail))).toEqual([])
        expect(await store.scan(["unrelated"])).toHaveLength(200)
        expect(await store.scan(["inbox"])).toEqual([])
        expect((await store.verify()).issues).toEqual([])
        const prefix = ["retired", "owner"]
        const keys = Array.from({ length: 5000 }, (_, index) => [...prefix, "chunks", String(index)])
        keys.push([...prefix, ...Array.from({ length: 32 }, (_, index) => `level-${index}`)])
        await store.transaction((tx) => tx.writeMany(keys.map((key) => ({ key, value: { saved: true } }))))
        statements.length = 0
        await store.removeTree(prefix)
        expect(statements.length).toBeLessThanOrEqual(prefix.length)
        expect(await store.scan(["retired"])).toEqual([])
        expect(await store.scan(["unrelated"])).toHaveLength(200)
        expect((await store.verify()).issues).toEqual([])
      } finally {
        await store.close()
      }
    }))

  for (const shape of ["wide", "deep"] as const) {
    test(`physical pruning drains a ${shape} tree in format ${format}`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir()
        const filename = path.join(tmp.path, "agent.sqlite")
        if (format === 2) createV2Store({ filename, namespace: "prune", records: [] })
        const store = await TransactionalStore.open({ backend: "sqlite", namespace: "prune", filename })
        try {
          const prefix = ["evidence", "expired"]
          const keys =
            shape === "wide"
              ? Array.from({ length: 5000 }, (_, index) => [...prefix, "chunks", String(index)])
              : [[...prefix, ...Array.from({ length: 82 }, (_, index) => String(index)), "leaf"]]
          await store.transaction(async (tx) => {
            await tx.writeMany(keys.map((key) => ({ key, value: { saved: true } })))
            await tx.write(["evidence", "retained"], { saved: true })
          })
          expect(await store.pruneTree(prefix)).toBe(keys.length)
          expect(await store.list(prefix)).toEqual([])
          expect(await store.scan(["evidence"])).toEqual(["retained"])
          expect((await store.verify()).issues).toEqual([])
          const database = new Database(filename, { readonly: true })
          try {
            expect(
              database.query("SELECT COUNT(*) AS count FROM storage_nodes WHERE namespace = ?").get("prune"),
            ).toEqual({ count: 2 })
          } finally {
            database.close()
          }
        } finally {
          await store.close()
        }
      }))
  }
}
