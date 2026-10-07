import { expect, spyOn, test } from "bun:test"
import { SQL } from "bun"
import { PostgresDriver } from "../../src/storage/postgres-driver"
import { TransactionalStore } from "../../src/storage/transactional-store"
import type {
  SqlConnection,
  SqlQueryOptions,
  SqlRow,
  SqlTransactionOptions,
  SqlValue,
} from "../../src/storage/sql-contract"
import { storageTestBackends } from "../support/storage-backends"

interface Plan {
  "Relation Name"?: string
  "Actual Rows"?: number
  "Actual Loops"?: number
  "Rows Removed by Filter"?: number
  Plans?: Plan[]
}

function nodeVisits(plan: Plan): number {
  const own =
    plan["Relation Name"] === "storage_nodes"
      ? ((plan["Actual Rows"] ?? 0) + (plan["Rows Removed by Filter"] ?? 0)) * (plan["Actual Loops"] ?? 0)
      : 0
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + nodeVisits(child), 0)
}

test.skipIf(!storageTestBackends().includes("postgres"))(
  "PostgreSQL batched node cleanup bounds actual work with stale namespace statistics",
  async () => {
    const url = process.env.SYNERGY_TEST_POSTGRES_URL!
    const sql = new SQL(url, { max: 1 })
    const stores: TransactionalStore[] = []
    try {
      const open = async () => {
        const store = await TransactionalStore.open({ backend: "postgres", url, namespace: crypto.randomUUID() })
        stores.push(store)
        return store
      }
      const historical = await open()
      const survivors = Array.from({ length: 600 }, (_, index) => ({
        key: ["retained", "records", String(index)],
        value: { index },
      }))
      await historical.transaction((tx) => tx.writeMany(survivors))
      await sql`ANALYZE storage_nodes`
      await sql`ANALYZE storage_records`

      // New namespaces can have no statistics while older namespaces already do.
      const current = await open()
      const removed = Array.from({ length: 40 }, (_, index) => ["pending", "delivery", String(index)])
      await current.transaction((tx) =>
        tx.writeMany([...survivors, ...removed.map((key) => ({ key, value: { pending: true } }))]),
      )
      const [count] =
        await sql`SELECT count(*)::integer AS nodes FROM storage_nodes WHERE namespace = ${current.options.namespace}`
      const visits: number[] = []
      const transaction = PostgresDriver.prototype.transaction
      using observed = spyOn(PostgresDriver.prototype, "transaction").mockImplementation(async function <T>(
        this: PostgresDriver,
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
                if (statement.includes("DELETE FROM storage_nodes") && statement.includes("RETURNING key_id")) {
                  await connection.query("SAVEPOINT cleanup_plan")
                  try {
                    const [row] = await connection.query("EXPLAIN (ANALYZE, FORMAT JSON) " + statement, values)
                    const raw = row!["QUERY PLAN"]
                    const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as unknown as { Plan: Plan }[]
                    visits.push(nodeVisits(plan[0]!.Plan))
                  } finally {
                    await connection.query("ROLLBACK TO SAVEPOINT cleanup_plan")
                    await connection.query("RELEASE SAVEPOINT cleanup_plan")
                  }
                }
                return connection.query<Row>(statement, values, queryOptions)
              },
            }),
          options,
        )) as T
      })

      await current.transaction((tx) => tx.removeMany(removed))
      expect(visits.length).toBeGreaterThan(0)
      // Allow one candidate join per bounded key batch, never another walk for
      // every outer deletion row. Count database work rather than wall time.
      expect(Math.max(...visits)).toBeLessThan(Number(count.nodes) * removed.length * 2)
      expect(await current.readMany(removed)).toEqual(removed.map(() => undefined))
      expect(await current.scan([])).toEqual(["retained"])
      expect(await current.readMany(survivors.map((entry) => entry.key))).toEqual(survivors.map((entry) => entry.value))
      expect(await historical.readMany(survivors.map((entry) => entry.key))).toEqual(
        survivors.map((entry) => entry.value),
      )
      expect((await current.verify()).issues).toEqual([])
    } finally {
      await Promise.all(stores.map((store) => store.close()))
      await sql.close()
    }
  },
  30_000,
)
