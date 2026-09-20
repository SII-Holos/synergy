import { expect, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { StorageBudgets } from "../../src/storage/budgets"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import type { SqlConnection, SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "verification-"))
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "verify",
    filename: path.join(root, "agent.sqlite"),
  })
  return {
    store,
    filename: path.join(root, "agent.sqlite"),
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("verification checks logical identities and reports missing parent records", async () => {
  await using fixtureStore = await fixture()
  const { store } = fixtureStore
  await store.write(["sessions", "scope", "ses_one", "info"], { id: "ses_one", scope: { id: "scope" } })
  await store.write(["sessions", "scope", "ses_one", "messages", "msg_one", "parts", "part_one"], {
    id: "part_one",
    sessionID: "ses_one",
    messageID: "msg_one",
  })
  const broken = await store.verify()
  expect(broken.records).toBe(2)
  expect(broken.issues).toEqual([
    { key: ["sessions", "scope", "ses_one", "messages", "msg_one", "parts", "part_one"], reason: "missing_message" },
  ])
  await store.write(["sessions", "scope", "ses_one", "messages", "msg_one", "info"], {
    id: "msg_one",
    sessionID: "ses_one",
  })
  expect((await store.verify()).issues).toEqual([])
})

test("maintenance statements keep a fixed chunk budget bounded below the worker ceiling", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "verification-budget-"))
  const driver = await SqliteDriver.open(path.join(root, "agent.sqlite"))
  try {
    await driver.transaction((tx) => tx.query("CREATE TABLE evidence (body BLOB NOT NULL)"))
    const timeout = globalThis.setTimeout
    const deadlines: number[] = []
    using observed = spyOn(globalThis, "setTimeout").mockImplementation(
      new Proxy(timeout, {
        apply(target, receiver, args) {
          const delay = args[1]
          if (typeof delay === "number" && delay >= 30_000) deadlines.push(delay)
          return Reflect.apply(target, receiver, args)
        },
      }),
    )
    const budgets: number[] = []
    const maintenance = { maintenance: true, onMaintenanceBudget: (timeoutMs: number) => budgets.push(timeoutMs) }
    expect(await driver.query("PRAGMA integrity_check", [], maintenance)).toEqual([{ integrity_check: "ok" }])
    const initial = Math.max(...deadlines)
    expect(budgets).toEqual([initial])
    // A statement can no longer buy itself a longer budget by growing the
    // database: every maintenance statement shares one fixed chunk budget that
    // leaves a margin below the ceiling the driver measures silence against.
    await driver.transaction((tx) => tx.query("INSERT INTO evidence VALUES (zeroblob(8388608))"))
    deadlines.length = 0
    await driver.transaction(
      async (tx) => {
        expect(await tx.query("PRAGMA integrity_check", [], maintenance)).toEqual([{ integrity_check: "ok" }])
      },
      { readOnly: true },
    )
    expect(Math.max(...deadlines)).toBe(initial)
    expect(budgets).toEqual([initial, initial])
    const current = StorageBudgets.current()
    expect(initial).toBe(current.chunkBudgetMs)
    expect(initial * StorageBudgets.ceilingMargin()).toBeLessThanOrEqual(current.hardCeilingMs)
    deadlines.length = 0
    expect(await driver.query("SELECT 1 AS value")).toEqual([{ value: 1n }])
    expect(deadlines).toEqual([current.requestDeadlineMs])
  } finally {
    await driver.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const defect of ["missing-node", "changed-node", "invalid-revision"] as const) {
  test(`verification and export reject ${defect} beyond the first page`, async () => {
    await using data = await fixture()
    await data.store.transaction((tx) =>
      tx.writeMany(Array.from({ length: 600 }, (_, i) => ({ key: ["fixture", String(i)], value: { i } }))),
    )
    initializeSqliteEngine()
    const database = new Database(data.filename)
    try {
      const select = database.query<{ key_id: Uint8Array }, []>(
        "SELECT key_id FROM storage_records WHERE namespace='verify' ORDER BY key_id DESC LIMIT 1",
      )
      const row = select.get()!
      select.finalize()
      if (defect === "missing-node")
        database.run("DELETE FROM storage_nodes WHERE namespace='verify' AND key_id=?", [row.key_id])
      // Format 3 stores no per-node path text, so the equivalent defect is a node
      // whose own derived columns no longer name the record it indexes.
      if (defect === "changed-node")
        database.run("UPDATE storage_nodes SET segment='[]' WHERE namespace='verify' AND key_id=?", [row.key_id])
      if (defect === "invalid-revision")
        database.run("UPDATE storage_records SET revision=0 WHERE namespace='verify' AND key_id=?", [row.key_id])
    } finally {
      database.close()
    }
    await expect(data.store.verify()).rejects.toThrow("Logical storage index integrity verification failed")
    await expect(
      data.store.transaction(async (tx) => {
        let records = 0
        for await (const _entry of tx.exportEntries()) records++
        return records
      }),
    ).rejects.toThrow("Logical storage index integrity verification failed")
  })
}

test("verification reports outside retried transactions and counts repeated scan work", async () => {
  await using data = await fixture()
  await data.store.transaction(async (tx) => {
    for (let i = 0; i < 600; i++) await tx.write(["fixture", String(i)], { retained: true })
  })
  const context = new AsyncLocalStorage<boolean>()
  const transaction = SqliteDriver.prototype.transaction
  const progress: number[] = []
  const budgets: number[] = []
  using retried = spyOn(SqliteDriver.prototype, "transaction").mockImplementation(async function <T>(
    this: SqliteDriver,
    body: (connection: SqlConnection) => Promise<T>,
    options?: { readOnly?: boolean; operationID?: string },
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await transaction.call(
          this,
          (connection) =>
            context.run(true, async () => {
              const result = await body(connection)
              if (!attempt) throw new Error("retry the completed scan")
              return result
            }),
          options,
        )) as T
      } catch (error) {
        if (attempt || !(error instanceof Error) || error.message !== "retry the completed scan") throw error
      }
    }
  })
  const result = await data.store.verify((current, timeoutMs) => {
    expect(context.getStore()).toBeUndefined()
    progress.push(current)
    if (timeoutMs !== undefined) budgets.push(timeoutMs)
  })
  expect(result.records).toBe(600)
  expect(budgets).toHaveLength(2)
  expect(budgets.every((value) => value === StorageBudgets.current().chunkBudgetMs)).toBe(true)
  expect(progress.at(-1)).toBe(1200)
  expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true)
})

test("logical index verification stays inside bounded primary-key pages", async () => {
  await using data = await fixture()
  await data.store.transaction(async (tx) => {
    await tx.writeMany(Array.from({ length: 600 }, (_, i) => ({ key: ["fixture", String(i)], value: { i } })))
  })
  const transaction = SqliteDriver.prototype.transaction
  const plans: string[] = []
  using observed = spyOn(SqliteDriver.prototype, "transaction").mockImplementation(async function <T>(
    this: SqliteDriver,
    body: (connection: SqlConnection) => Promise<T>,
    options?: { readOnly?: boolean; operationID?: string },
  ) {
    return (await transaction.call(
      this,
      (connection) =>
        body({
          async query<Row extends SqlRow>(statement: string, values: SqlValue[] = [], queryOptions?: SqlQueryOptions) {
            if (statement.startsWith("SELECT") && /storage_(records|nodes)/.test(statement)) {
              const rows = await connection.query<{ detail: string }>("EXPLAIN QUERY PLAN " + statement, values)
              plans.push(...rows.map((row) => row.detail))
            }
            return connection.query<Row>(statement, values, queryOptions)
          },
        }),
      options,
    )) as T
  })
  expect((await data.store.verify()).records).toBe(600)
  // Format 3 verifies in bounded pages instead of one join per record page: the
  // record page seeks its primary index, and the nodes for that page are
  // resolved by key against the node primary index. Neither read is a scan of
  // either table, which is what keeps verification bounded on a large store.
  const recordSeeks = plans.filter((plan) => /sqlite_autoindex_storage_records_1/.test(plan))
  const nodeSeeks = plans.filter((plan) => /sqlite_autoindex_storage_nodes_1/.test(plan))
  expect(recordSeeks.length).toBeGreaterThan(0)
  expect(nodeSeeks.length).toBeGreaterThan(0)
  // The record page walks forward on its primary index, and every node read is
  // keyed -- either the record page's own node lookup or the orphan walk's
  // descent. No statement scans either table.
  expect(recordSeeks.some((plan) => /key_id>/.test(plan))).toBe(true)
  expect(plans.every((plan) => !/SCAN (r|storage_records|storage_nodes)\b/.test(plan))).toBe(true)
})
