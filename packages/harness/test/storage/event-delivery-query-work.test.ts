import { expect, spyOn, test } from "bun:test"
import { dlopen } from "bun:ffi"
import { Database } from "bun:sqlite"
import path from "node:path"
import fs from "node:fs/promises"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import { StoreTransaction, TransactionalStore, type RecordQuery } from "../../src/storage/transactional-store"
import type { SqlConnection, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import { StorageEventSinks } from "../../src/storage/event-sinks"
import { testRuntime } from "../support/runtime"

function probe(library: string) {
  const native = dlopen(library, {
    sqlite3_open_v2: { args: ["ptr", "ptr", "i32", "ptr"], returns: "i32" },
    sqlite3_close_v2: { args: ["ptr"], returns: "i32" },
    sqlite3_prepare_v2: { args: ["ptr", "ptr", "i32", "ptr", "ptr"], returns: "i32" },
    sqlite3_bind_text: { args: ["ptr", "i32", "ptr", "i32", "ptr"], returns: "i32" },
    sqlite3_bind_blob: { args: ["ptr", "i32", "ptr", "i32", "ptr"], returns: "i32" },
    sqlite3_bind_int64: { args: ["ptr", "i32", "i64"], returns: "i32" },
    sqlite3_bind_null: { args: ["ptr", "i32"], returns: "i32" },
    sqlite3_step: { args: ["ptr"], returns: "i32" },
    sqlite3_column_text: { args: ["ptr", "i32"], returns: "cstring" },
    sqlite3_stmt_status: { args: ["ptr", "i32", "i32"], returns: "i32" },
    sqlite3_finalize: { args: ["ptr"], returns: "i32" },
    sqlite3_errmsg: { args: ["ptr"], returns: "cstring" },
    sqlite3_sourceid: { returns: "cstring" },
  })
  const c = native.symbols
  const sourceID = c.sqlite3_sourceid()
  if (!sourceID) {
    native.close()
    throw new Error("The original SQLite engine has no source identity")
  }
  return {
    sourceID,
    [Symbol.dispose]: () => native.close(),
    measure(filename: string, statement: string, values: SqlValue[]) {
      const output = new BigUint64Array(1)
      const opened = c.sqlite3_open_v2(Buffer.from(filename + "\0"), output, 1, null)
      const database = output[0]!
      if (opened !== 0 || database === 0n) {
        if (database !== 0n) c.sqlite3_close_v2(database)
        throw new Error(`Readonly SQLite work probe failed: ${opened}`)
      }
      let prepared = 0n
      try {
        const preparedResult = c.sqlite3_prepare_v2(database, Buffer.from(statement + "\0"), -1, output, null)
        prepared = output[0]!
        if (preparedResult !== 0 || prepared === 0n) throw new Error(String(c.sqlite3_errmsg(database)))
        const retained: Uint8Array[] = []
        for (let index = 0; index < values.length; index++) {
          const value = values[index]!
          let bound: number
          if (value === null) bound = c.sqlite3_bind_null(prepared, index + 1)
          else if (typeof value === "string") {
            const bytes = Buffer.from(value, "utf8")
            retained.push(bytes)
            bound = c.sqlite3_bind_text(prepared, index + 1, bytes, bytes.byteLength, null)
          } else if (value instanceof Uint8Array) {
            retained.push(value)
            bound = c.sqlite3_bind_blob(prepared, index + 1, value, value.byteLength, null)
          } else bound = c.sqlite3_bind_int64(prepared, index + 1, BigInt(value))
          if (bound !== 0) throw new Error(String(c.sqlite3_errmsg(database)))
        }
        const keys: string[] = []
        let result: number
        while ((result = c.sqlite3_step(prepared)) === 100) keys.push(String(c.sqlite3_column_text(prepared, 0)))
        if (result !== 101) throw new Error(String(c.sqlite3_errmsg(database)))
        // SQLITE_STMTSTATUS_VM_STEP counts indexed loops as well as table scans.
        const steps = c.sqlite3_stmt_status(prepared, 4, 0)
        const sorts = c.sqlite3_stmt_status(prepared, 2, 0)
        expect(retained.length).toBeGreaterThan(0)
        return { keys, steps, sorts }
      } finally {
        if (prepared !== 0n) c.sqlite3_finalize(prepared)
        c.sqlite3_close_v2(database)
      }
    },
  }
}

const sinkID = "query-work"
const partition = "selected%_partition雪"
const key = (owner: string, sequence: number) => ["event_delivery", sinkID, owner, String(sequence).padStart(16, "0")]
const delivery = (owner: string, sequence: number): StorageEventSinks.Delivery => ({
  version: 1,
  sinkID,
  partition: owner,
  sequence,
  eventID: `${owner}-${sequence}`,
  payload: { accepted: true },
})

async function sample(directory: string, history: number, native: ReturnType<typeof probe>, input: RecordQuery) {
  const filename = path.join(directory, `${history}.sqlite`)
  const store = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "query-work" })
  const old = Array.from({ length: history }, (_, index) => key(partition, index + 1))
  const latest = key(partition, history + 1)
  try {
    await store.transaction(async (tx) => {
      await tx.writeMany(old.map((key, index) => ({ key, value: delivery(partition, index + 1) })))
      await tx.removeMany(old)
      await tx.writeMany(
        Array.from({ length: history }, (_, index) => ({
          key: key(partition + "-other", index + 1),
          value: delivery(partition + "-other", index + 1),
        })),
      )
      await tx.write(latest, delivery(partition, history + 1))
    })
  } finally {
    await store.close()
  }
  const database = new Database(filename, { readonly: true })
  try {
    expect(database.query<{ id: string }, []>("SELECT sqlite_source_id() AS id").get()!.id).toBe(native.sourceID)
    const plans: string[] = []
    const statements: Array<{ sql: string; values: SqlValue[] }> = []
    const connection: SqlConnection = {
      async query<Row extends SqlRow>(sql: string, values: SqlValue[] = []) {
        statements.push({ sql, values })
        const plan = database.query<{ detail: string }, SqlValue[]>("EXPLAIN QUERY PLAN " + sql)
        plans.push(...plan.all(...values).map((row) => row.detail))
        plan.finalize()
        const query = database.query<Row, SqlValue[]>(sql)
        try {
          return query.all(...values)
        } finally {
          query.finalize()
        }
      },
    }
    const transaction = new StoreTransaction(connection, "query-work", true)
    try {
      const rows = await transaction.query<StorageEventSinks.Delivery>(input)
      expect(rows.map((row) => row.key)).toEqual([latest])
      expect(rows[0]!.value).toEqual(delivery(partition, history + 1))
      expect(rows[0]!.revision).toBe(1n)
    } finally {
      transaction.finish()
    }
    expect(statements).toHaveLength(1)
    const selected = statements[0]!
    const measured = native.measure(filename, selected.sql, selected.values)
    expect(measured.keys).toEqual([JSON.stringify(latest)])
    const count = database.query<{ total: number; retired: number }, [string]>(
      "SELECT COUNT(*) AS total, SUM(body IS NULL) AS retired FROM storage_records WHERE namespace = ? AND kind = 'event_delivery'",
    )
    try {
      expect(count.get("query-work")).toEqual({ total: 2 * history + 1, retired: history })
    } finally {
      count.finalize()
    }
    return { history, ...measured, plans }
  } finally {
    database.close()
  }
}

test.skipIf(process.platform !== "darwin")(
  "a selected delivery page has bounded SQLite work despite acknowledged history and foreign partitions",
  async () => {
    let library: string | undefined
    const setEngine = Database.setCustomSQLite
    using selected = spyOn(Database, "setCustomSQLite").mockImplementation((filename) => {
      library = filename
      return setEngine.call(Database, filename)
    })
    initializeSqliteEngine()
    if (!library) throw new Error("The native work probe requires fresh canonical SQLite engine selection")
    using native = probe(library)
    const runtime = await testRuntime({
      register: () =>
        StorageEventSinks.register({
          id: sinkID,
          capture: () => undefined,
          deliver: async () => {},
        }),
    })
    let input: RecordQuery | undefined
    try {
      using queries = spyOn(StoreTransaction.prototype, "query")
      expect(await runtime.run(() => StorageEventSinks.flush({ sinkID, partition, limit: 1 }))).toEqual({
        delivered: 0,
      })
      input = queries.mock.calls
        .map(([value]) => value)
        .find((value) => JSON.stringify(value.prefix) === JSON.stringify(["event_delivery", sinkID, partition]))
    } finally {
      await runtime.close()
    }
    if (!input) throw new Error("The actual partition flush did not issue its owning record query")
    const testRoot = process.env.SYNERGY_TEST_ROOT
    if (!testRoot) throw new Error("The work probe requires an isolated test root")
    const directory = await fs.mkdtemp(path.join(testRoot, "event-delivery-work-"))
    try {
      const small = await sample(directory, 128, native, input)
      const large = await sample(directory, 2048, native, input)
      console.info(JSON.stringify({ kind: "delivery-query-work", small, large }))
      expect(large.steps).toBeLessThan(small.steps * 4)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  20000,
)
