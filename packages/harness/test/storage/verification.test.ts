import { expect, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { observeStorageMaintenance } from "../../src/storage/maintenance-progress"
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

test("SQLite maintenance budgets grow with the current database while ordinary deadlines stay bounded", async () => {
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
    const maintenance = { maintenance: "integrity-check" as const }
    const observe = <T>(operation: () => Promise<T>) =>
      observeStorageMaintenance(operation, (event) => {
        if (event.state === "started") budgets.push(event.timeoutMs)
      })
    expect(await observe(() => driver.query("PRAGMA integrity_check", [], maintenance))).toEqual([
      { integrity_check: "ok" },
    ])
    const initial = Math.max(...deadlines)
    expect(budgets).toEqual([initial + 90_000])
    await driver.transaction((tx) => tx.query("INSERT INTO evidence VALUES (zeroblob(8388608))"))
    deadlines.length = 0
    await observe(() =>
      driver.transaction(
        async (tx) => {
          expect(await tx.query("PRAGMA integrity_check", [], maintenance)).toEqual([{ integrity_check: "ok" }])
        },
        { readOnly: true },
      ),
    )
    expect(Math.max(...deadlines)).toBeGreaterThan(initial)
    expect(budgets).toEqual([initial + 90_000, Math.max(...deadlines) + 90_000])
    deadlines.length = 0
    expect(await driver.query("SELECT 1 AS value")).toEqual([{ value: 1n }])
    expect(deadlines).toEqual([30_000])
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
      const select = database.query<{ key_id: string }, []>(
        "SELECT key_id FROM storage_records WHERE namespace='verify' ORDER BY key_id DESC LIMIT 1",
      )
      const row = select.get()!
      select.finalize()
      if (defect === "missing-node")
        database.run("DELETE FROM storage_nodes WHERE namespace='verify' AND key_id=?", [row.key_id])
      if (defect === "changed-node")
        database.run("UPDATE storage_nodes SET key_text='[]' WHERE namespace='verify' AND key_id=?", [row.key_id])
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
  const result = await observeStorageMaintenance(
    () =>
      data.store.verify((current) => {
        expect(context.getStore()).toBeUndefined()
        progress.push(current)
      }),
    (event) => {
      expect(context.getStore()).toBeUndefined()
      if (event.state === "started") budgets.push(event.timeoutMs)
    },
  )
  expect(result.records).toBe(600)
  expect(budgets).toHaveLength(2)
  expect(budgets.every((value) => value >= 600_000)).toBe(true)
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
            if (
              statement.startsWith("SELECT") &&
              statement.includes("storage_records") &&
              statement.includes("storage_nodes")
            ) {
              const rows = await connection.query<{ detail: string }>("EXPLAIN QUERY PLAN " + statement, values)
              plans.push(
                ...rows.map((row) => row.detail).filter((detail) => /SEARCH (r|storage_records) /.test(detail)),
              )
            }
            return connection.query<Row>(statement, values, queryOptions)
          },
        }),
      options,
    )) as T
  })
  expect((await data.store.verify()).records).toBe(600)
  expect(plans.length).toBeGreaterThan(2)
  expect(plans.every((plan) => /key_id>/.test(plan))).toBe(true)
})

test("physical maintenance announces distinct finite startup budgets outside ordinary queries", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "maintenance-progress-"))
  const driver = await SqliteDriver.open(path.join(root, "agent.sqlite"))
  const reports: Array<{ id: number; state: string; timeoutMs?: number }> = []
  try {
    await observeStorageMaintenance(
      async () => {
        await driver.query("SELECT 1")
        expect(reports).toEqual([])
        await driver.query("PRAGMA integrity_check", [], { maintenance: "integrity-check" })
        await driver.query("PRAGMA integrity_check", [], { maintenance: "integrity-check" })
      },
      (value) => reports.push(value),
    )
    const starts = reports.filter((value) => value.state === "started")
    expect(starts.map((value) => value.id)).toEqual([1, 2])
    expect(starts.every((value) => Number.isFinite(value.timeoutMs) && value.timeoutMs! >= 30_000)).toBe(true)
  } finally {
    await driver.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
