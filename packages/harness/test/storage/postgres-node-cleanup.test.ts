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
  "Node Type"?: string
  "Relation Name"?: string
  "Actual Rows"?: number
  "Actual Loops"?: number
  "Rows Removed by Filter"?: number
  Plans?: Plan[]
}

function nodeVisits(plan: Plan): number {
  const own =
    (plan["Relation Name"] === "storage_nodes" || plan["Relation Name"] === "storage_records") &&
    plan["Node Type"] !== "ModifyTable"
      ? ((plan["Actual Rows"] ?? 0) + (plan["Rows Removed by Filter"] ?? 0)) * (plan["Actual Loops"] ?? 0)
      : 0
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + nodeVisits(child), 0)
}

function observeCleanup(trace: { visits: number[]; pages?: number[]; mutations?: number[] }) {
  const transaction = PostgresDriver.prototype.transaction
  return spyOn(PostgresDriver.prototype, "transaction").mockImplementation(async function <T>(
    this: PostgresDriver,
    body: (connection: SqlConnection) => Promise<T>,
    options?: SqlTransactionOptions,
  ) {
    return (await transaction.call(
      this,
      (c) =>
        body({
          async query<Row extends SqlRow>(statement: string, values: SqlValue[] = [], settings?: SqlQueryOptions) {
            const deletion = statement.includes("DELETE FROM storage_nodes") && statement.includes("RETURNING key_id")
            const discovery = statement.replace(/^DECLARE cleanup_nodes_\d+ SCROLL CURSOR FOR /, "")
            if (deletion || discovery.startsWith("WITH RECURSIVE roots")) {
              await c.query("SAVEPOINT measure_cleanup")
              try {
                const [row] = await c.query("EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) " + discovery, values)
                const raw = row!["QUERY PLAN"]
                const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: Plan }[]
                trace.visits.push(nodeVisits(plan[0]!.Plan))
              } finally {
                await c.query("ROLLBACK TO SAVEPOINT measure_cleanup")
                await c.query("RELEASE SAVEPOINT measure_cleanup")
              }
            }
            const rows = await c.query<Row>(statement, values, settings)
            if (statement.startsWith("FETCH ")) trace.pages?.push(rows.length)
            if (deletion) trace.mutations?.push(rows.length)
            return rows
          },
        }),
      options,
    )) as T
  })
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
      using observed = observeCleanup({ visits })

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
      visits.length = 0
      await current.transaction(async (tx) => {
        await tx.remove(removed[0]!)
        await tx.remove(["never-created", "nested", "completion"])
        await tx.removeMany(removed)
      })
      expect(visits).toEqual([])
      expect(await current.readMany(survivors.map((entry) => entry.key))).toEqual(survivors.map((entry) => entry.value))
      expect((await current.verify()).issues).toEqual([])
    } finally {
      await Promise.all(stores.map((store) => store.close()))
      await sql.close()
    }
  },
  30_000,
)

test.skipIf(!storageTestBackends().includes("postgres"))(
  "small node cleanup seeks within an analyzed namespace and large subtrees are paged",
  async () => {
    const url = process.env.SYNERGY_TEST_POSTGRES_URL!
    const sql = new SQL(url, { max: 1 })
    const namespace = crypto.randomUUID()
    const store = await TransactionalStore.open({ backend: "postgres", url, namespace })
    const leaves = Array.from({ length: 12 }, (_, i) => ["batch", "inner", "leaves", String(i)])
    const parents = Array.from({ length: 12 }, (_, i) => ["batch", "retained", String(i)])
    const large = ["batch", "wide"]
    const width = 513
    try {
      await store.transaction((tx) =>
        tx.writeMany(
          [
            ...Array.from({ length: 9000 }, (_, i) => ["other", String(Math.floor(i / 11)), String(i)]),
            ...leaves,
            ...parents,
            ...parents.map((key) => [...key, "live"]),
            large,
            ...Array.from({ length: width }, (_, i) => [...large, String(i)]),
          ].map((key) => ({ key, value: true })),
        ),
      )
      await sql`ANALYZE storage_nodes`
      await sql`ANALYZE storage_records`
      const visits: number[] = []
      const pages: number[] = []
      const mutations: number[] = []
      using observed = observeCleanup({ visits, pages, mutations })
      await store.transaction((tx) => tx.removeMany(leaves))
      expect(visits.reduce((total, value) => total + value, 0)).toBeLessThan(512)
      expect(await store.scan(["batch", "inner"])).toEqual([])
      visits.length = 0
      mutations.length = 0
      await store.transaction((tx) => tx.removeMany(parents))
      expect(mutations).toEqual([0])
      expect(visits.reduce((total, value) => total + value, 0)).toBeLessThan(512)
      expect(await store.readMany(parents.map((key) => [...key, "live"]))).toEqual(parents.map(() => true))

      // Retained historical nodes can outlive their records. The addressed sweep
      // must still drain them when the root record is removed.
      await sql`UPDATE storage_records SET body = NULL WHERE namespace = ${namespace}
          AND key_text LIKE '["batch","wide",%'`
      const rollback = new Error("rollback wide cleanup")
      await expect(
        store.transaction(async (tx) => {
          await tx.remove(large)
          throw rollback
        }),
      ).rejects.toThrow(rollback.message)
      expect(await store.read(large)).toBe(true)
      const [before] = await sql`SELECT count(*)::int AS n FROM storage_nodes WHERE namespace = ${namespace}`
      visits.length = 0
      await store.remove(large)
      const [after] = await sql`SELECT count(*)::int AS n FROM storage_nodes WHERE namespace = ${namespace}`
      expect(before.n - after.n).toBe(width + 1)
      expect(visits.reduce((sum, n) => sum + n, 0)).toBeLessThan(width * 12)
      expect(pages.length).toBeGreaterThan(1)
      expect(Math.max(...pages)).toBeLessThanOrEqual(128)
      expect(Math.max(...mutations)).toBeLessThanOrEqual(128)
      expect(await store.read(["other", "0", "0"])).toBe(true)
    } finally {
      await store.close()
      await sql.close()
    }
  },
  45_000,
)
