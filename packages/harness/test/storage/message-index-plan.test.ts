import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { TransactionalStore } from "../../src/storage/transactional-store"
import type { SqlConnection, SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "message-index-plan-"))
const stores: TransactionalStore[] = []

afterAll(() =>
  runtime.run(async () => {
    await Promise.all(stores.map((store) => store.close().catch(() => {})))
    await fs.rm(root, { recursive: true, force: true })
  }),
)

test("a message_id page seeks the partial message index instead of scanning records", () =>
  runtime.run(async () => {
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "message-plan",
      filename: path.join(root, "plan.sqlite"),
    })
    stores.push(store)

    await store.transaction(async (tx) => {
      for (let index = 0; index < 4000; index++) {
        // Rollout rows carry an empty `message_id`, the shape most of a real store
        // holds; the message rows are what the partial index has to serve.
        await tx.write(
          ["sessions", `scope_${index % 8}`, `ses_${index % 64}`, "rollout", "runs", `run_${index}`, "info"],
          {
            index,
          },
        )
        await tx.write(["sessions", `scope_${index % 8}`, `ses_${index % 64}`, "messages", `msg_${index}`, "info"], {
          id: `msg_${index}`,
          text: "x".repeat(80),
        })
      }
    })

    // The plan comes from the statement the store itself issues, captured as it
    // runs, so the assertion covers the real read shape rather than a copy of it.
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
            async query<Row extends SqlRow>(
              statement: string,
              values: SqlValue[] = [],
              queryOptions?: SqlQueryOptions,
            ) {
              if (statement.startsWith("SELECT") && statement.includes("message_id =")) {
                const rows = await connection.query<{ detail: string }>("EXPLAIN QUERY PLAN " + statement, values)
                plans.push(...rows.map((row) => row.detail))
              }
              return connection.query<Row>(statement, values, queryOptions)
            },
          }),
        options,
      )) as T
    })

    const page = await store.query({ messageID: "msg_7", limit: 100 })
    expect(page).toHaveLength(1)
    expect(page[0]!.value).toMatchObject({ id: "msg_7" })

    expect(plans.length).toBeGreaterThan(0)
    const detail = plans.join(" | ")
    // The partial index is the one chosen; the predicate `message_id <> ''` the
    // store restates is what lets the planner prove the index applies to this
    // equality, since the index itself excludes ownerless rows.
    expect(detail).toContain("storage_records_message")
    // A scan of the record table is the defect this index exists to prevent: it
    // would read all 8,000 rows to answer a one-row page.
    expect(detail).not.toContain("SCAN storage_records")
    expect(detail).not.toContain("SCAN r")
  }))

afterRuntimeTests(() => runtime.close())
