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

function visited(plan: Plan): number {
  const own =
    plan["Relation Name"] === "storage_records"
      ? ((plan["Actual Rows"] ?? 0) + (plan["Rows Removed by Filter"] ?? 0)) * (plan["Actual Loops"] ?? 0)
      : 0
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + visited(child), 0)
}

test.skipIf(!storageTestBackends().includes("postgres"))(
  "PostgreSQL kind pages skip retained tombstones and preserve live cursors",
  async () => {
    const url = process.env.SYNERGY_TEST_POSTGRES_URL!
    const namespace = crypto.randomUUID()
    const store = await TransactionalStore.open({ backend: "postgres", url, namespace })
    const sql = new SQL(url, { max: 1 })
    try {
      // Retained revisions are legitimate authority even after delivery cleanup.
      await sql`INSERT INTO storage_records(namespace,key_id,key_text,body,revision,kind,scope_id,session_id,message_id,order_key,updated)
        SELECT ${namespace},encode(sha256(convert_to(key_text,'UTF8')),'hex'),key_text,NULL,2,'event_delivery','','','',segment,0
        FROM (SELECT lpad(i::text,12,'0') AS segment, '["event_delivery","' || lpad(i::text,12,'0') || '"]' AS key_text FROM generate_series(1,45093) i) fixture`
      await sql`INSERT INTO storage_records(namespace,key_id,key_text,body,revision,kind,scope_id,session_id,message_id,order_key,updated)
        SELECT ${namespace},encode(sha256(convert_to(key_text,'UTF8')),'hex'),key_text,'true',1,'retained','','','',segment,0
        FROM (SELECT i::text AS segment, '["retained","' || i::text || '"]' AS key_text FROM generate_series(1,5000) i) fixture`
      await sql`ANALYZE storage_records`
      const transaction = PostgresDriver.prototype.transaction
      const work: number[] = []
      using observe = spyOn(PostgresDriver.prototype, "transaction").mockImplementation(async function <T>(
        this: PostgresDriver,
        body: (connection: SqlConnection) => Promise<T>,
        options?: SqlTransactionOptions,
      ) {
        return (await transaction.call(
          this,
          (connection) =>
            body({
              async query<Row extends SqlRow>(statement: string, values: SqlValue[] = [], settings?: SqlQueryOptions) {
                if (statement.startsWith("SELECT key_text, body, revision") && statement.includes("kind = ?")) {
                  const [result] = await connection.query(
                    "EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) " + statement,
                    values,
                  )
                  const raw = result!["QUERY PLAN"]
                  const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: Plan }[]
                  work.push(visited(plan[0]!.Plan))
                }
                return connection.query<Row>(statement, values, settings)
              },
            }),
          options,
        )) as T
      })
      expect(await store.query({ kind: "event_delivery", limit: 1 })).toEqual([])
      expect(work).toEqual([0])
      const keys = ["z1", "z2", "z3"].map((id) => ["event_delivery", id])
      await store.transaction((tx) => tx.writeMany(keys.map((key) => ({ key, value: { id: key[1] } }))))
      expect((await store.query({ kind: "event_delivery", limit: 1 })).map((row) => row.key)).toEqual([keys[0]!])
      expect((await store.query({ kind: "event_delivery", limit: 1, after: keys[0]! })).map((row) => row.key)).toEqual([
        keys[1]!,
      ])
      expect((await store.query({ kind: "event_delivery", limit: 1, descending: true })).map((row) => row.key)).toEqual(
        [keys[2]!],
      )
      expect(Math.max(...work)).toBeLessThanOrEqual(3)
      await store.remove(keys[1]!)
      expect((await store.query({ kind: "event_delivery", limit: 1, after: keys[0]! })).map((row) => row.key)).toEqual([
        keys[2]!,
      ])
      expect(Math.max(...work)).toBeLessThanOrEqual(3)
      const [counts] =
        await sql`SELECT count(*)::integer AS total,count(body)::integer AS live FROM storage_records WHERE namespace=${namespace} AND kind='event_delivery'`
      expect(counts).toEqual({ total: 45096, live: 2 })
    } finally {
      await store.close()
      await sql`DELETE FROM storage_records WHERE namespace=${namespace}`
      await sql`DELETE FROM storage_nodes WHERE namespace=${namespace}`
      await sql`DELETE FROM storage_namespaces WHERE namespace=${namespace}`
      await sql.close()
    }
  },
  30_000,
)
