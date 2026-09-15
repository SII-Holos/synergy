import { expect, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import type { SqlConnection } from "../../src/storage/sql-contract"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "verification-"))
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "verify",
    filename: path.join(root, "agent.sqlite"),
  })
  return {
    store,
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

test("verification reports outside retried transactions and counts repeated scan work", async () => {
  await using data = await fixture()
  await data.store.transaction(async (tx) => {
    for (let i = 0; i < 600; i++) await tx.write(["fixture", String(i)], { retained: true })
  })
  const context = new AsyncLocalStorage<boolean>()
  const transaction = SqliteDriver.prototype.transaction
  const progress: number[] = []
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
  const result = await data.store.verify((current) => {
    expect(context.getStore()).toBeUndefined()
    progress.push(current)
  })
  expect(result.records).toBe(600)
  expect(progress.at(-1)).toBe(1200)
  expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true)
})
