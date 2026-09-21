import { afterAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { StorageUnavailableError } from "../../src/storage/errors"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { TransactionalStore } from "../../src/storage/transactional-store"
import type { SqlDriver } from "../../src/storage/sql-contract"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "unavailability-contract-"))
const stores: TransactionalStore[] = []

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close().catch(() => {})))
  await fs.rm(root, { recursive: true, force: true })
})

function driver(store: TransactionalStore) {
  return (store as unknown as { driver: SqlDriver }).driver
}

async function openSqlite(label: string) {
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: label,
    filename: path.join(root, `${label}.sqlite`),
  })
  stores.push(store)
  return store
}

/**
 * A driver may not opt out of the signal by omission.
 *
 * `{} extends Pick<T, K>` is true exactly when `K` is optional, so this line
 * fails to compile the moment `onUnavailable` becomes optional again. That is
 * the whole point of folding the requirement into the interface: a driver that
 * does not implement it cannot be passed where a `SqlDriver` is expected, which
 * is what previously let `Storage.onUnavailable` degrade into a silent no-op.
 */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false
const onUnavailableIsRequired: IsOptional<SqlDriver, "onUnavailable"> = false

describe("terminal unavailability is a declared driver contract", () => {
  test("the driver interface requires the signal rather than accepting its absence", () => {
    // The assertion is the type above; this keeps the gate executable so a
    // regression names the contract instead of failing in an unrelated build.
    expect(onUnavailableIsRequired).toBe(false)
  })

  test("Storage.onUnavailable reaches a subscriber when the driver signals", async () => {
    const open = SqliteDriver.open
    let opened: SqliteDriver | undefined
    using observed = spyOn(SqliteDriver, "open").mockImplementation(async (...args) => {
      opened = await open(...args)
      return opened
    })
    const store = await openSqlite("contract-signals")

    // Every production driver declares the method, so a caller can subscribe
    // without probing for capability first.
    expect(typeof driver(store).onUnavailable).toBe("function")

    const received: Error[] = []
    const stop = Storage.provide({ store, artifactDirectory: root }, () =>
      Storage.onUnavailable((error) => received.push(error)),
    )
    expect(typeof stop).toBe("function")

    const worker = opened as unknown as { worker: Bun.Subprocess }
    worker.worker.kill()
    await worker.worker.exited
    // The exit callback lands after `exited` resolves.
    await Bun.sleep(50)

    expect(received).toHaveLength(1)
    expect(received[0]).toBeInstanceOf(StorageUnavailableError)
    // The subscription is the driver's own: the store must not substitute a
    // fallback listener that no driver ever invokes.
    await expect(store.snapshot((tx) => tx.read(["record"]))).rejects.toBe(received[0])
  })

  test.skipIf(!process.env.SYNERGY_TEST_POSTGRES_URL)(
    "PostgreSQL declares the signal as unimplemented instead of omitting it",
    async () => {
      const namespace = crypto.randomUUID()
      const store = await TransactionalStore.open({
        backend: "postgres",
        namespace,
        url: process.env.SYNERGY_TEST_POSTGRES_URL!,
      })
      stores.push(store)
      const postgres = driver(store)
      expect(typeof postgres.onUnavailable).toBe("function")

      // A pool has no single-worker wedge, so no condition here terminalises the
      // Handle and the listener is never invoked: an ordinary write both succeeds
      // and leaves the subscription untouched.
      const received: Error[] = []
      const stop = postgres.onUnavailable((error) => received.push(error))
      expect(typeof stop).toBe("function")
      await store.write(["record"], { value: 1 })
      expect(await store.read<{ value: number }>(["record"])).toEqual({ value: 1 })
      expect(received).toEqual([])
      stop()
    },
  )
})
