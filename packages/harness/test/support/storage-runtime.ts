import { spyOn } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import type { TransactionalStore } from "../../src/storage/transactional-store"
import { RuntimeContext } from "../../src/lifecycle/context"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityWriter } from "../../src/observability/writer"
import { Log } from "../../src/util/log"
import { runtimeHome } from "./runtime-home"

export async function storageTestRuntime(
  options: { home?: string; environment?: Record<string, string | undefined> } = {},
) {
  const home = await runtimeHome(options)
  const context = RuntimeContext.create({ ...home.host, env: { ...home.host.env, ...options.environment } })
  return {
    run: context.run,
    async close() {
      try {
        await context.run(async () => {
          const errors: unknown[] = []
          for (const stop of [
            ObservabilityWriter.stop,
            ObservabilityMetrics.stop,
            ObservabilityStore.stop,
            Log.close,
          ]) {
            try {
              await stop()
            } catch (error) {
              errors.push(error)
            }
          }
          if (errors.length) throw new AggregateError(errors, "Storage test resources did not settle")
        })
      } finally {
        context.dispose()
        await home[Symbol.asyncDispose]()
      }
    },
  }
}

export function observeSqliteWriters() {
  const opened = new Map<string, SqliteDriver>()
  const open = SqliteDriver.open
  const observing = spyOn(SqliteDriver, "open").mockImplementation(async (...args) => {
    const driver = await open(...args)
    opened.set(args[0], driver)
    return driver
  })
  const stopObserving = () => observing.mockRestore()
  return {
    stopObserving,
    [Symbol.dispose]: stopObserving,
    async withMaxPageCount<T>(originalStore: TransactionalStore, body: () => Promise<T>): Promise<T> {
      if (
        Storage.current().store !== originalStore ||
        Storage.inTransaction() ||
        originalStore.options.backend !== "sqlite"
      )
        throw new Error("The page limit requires its original native SQLite owner outside a transaction")
      const driver = opened.get(originalStore.options.filename)
      if (!driver) throw new Error("The original native SQLite writer was not observed")
      const maximum = await driver.transaction(async (connection) => {
        const [prior] = await connection.query<{ max_page_count: number | bigint }>("PRAGMA max_page_count")
        const [pages] = await connection.query<{ page_count: number | bigint }>("PRAGMA page_count")
        const limit = Number(pages?.page_count) + 2
        if (!Number.isSafeInteger(limit) || limit < 3) throw new Error("Unexpected native SQLite page count")
        const [installed] = await connection.query<{ max_page_count: number | bigint }>(
          `PRAGMA max_page_count = ${limit}`,
        )
        if (Number(installed?.max_page_count) !== limit)
          throw new Error("The original SQLite page limit was not installed")
        return Number(prior?.max_page_count)
      })
      try {
        return await body()
      } finally {
        await driver.transaction((connection) => connection.query(`PRAGMA max_page_count = ${maximum}`))
      }
    },
  }
}
