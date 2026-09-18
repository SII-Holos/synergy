import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { StorageUnavailableError } from "../../src/storage/errors"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-escalation-"))
const stores: TransactionalStore[] = []

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close().catch(() => {})))
  await fs.rm(root, { recursive: true, force: true })
})

// Write paths reject synchronously once the store is closed, so both origins are
// captured rather than assuming every failure arrives as a rejected promise.
async function failure(operation: () => Promise<unknown>) {
  try {
    await operation()
  } catch (error) {
    return error
  }
  throw new Error("Expected the operation to fail")
}

test("an unexpected worker exit fails the store terminally and notifies its host once", async () => {
  const open = SqliteDriver.open
  let driver: SqliteDriver | undefined
  using observed = spyOn(SqliteDriver, "open").mockImplementation(async (...args) => {
    driver = await open(...args)
    return driver
  })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "escalation",
    filename: path.join(root, "agent.sqlite"),
  })
  stores.push(store)
  await store.write(["record"], { preserved: true })

  const unavailable: Error[] = []
  store.onUnavailable((error) => unavailable.push(error))

  const killing = driver! as unknown as { worker: Bun.Subprocess }
  killing.worker.kill()
  await killing.worker.exited
  // The exit callback lands after `exited` resolves.
  await Bun.sleep(50)

  expect(unavailable).toHaveLength(1)
  expect(unavailable[0]).toBeInstanceOf(StorageUnavailableError)
  expect(await failure(() => store.snapshot((tx) => tx.read(["record"])))).toBe(unavailable[0])
  expect(await failure(() => store.write(["record"], { replaced: true }))).toBe(unavailable[0])
  // Escalation is one-shot: a terminally failed store never notifies twice.
  expect(unavailable).toHaveLength(1)
})

test("an idle store never reports unavailability and unsubscribes cleanly", async () => {
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "escalation-clean",
    filename: path.join(root, "clean.sqlite"),
  })
  stores.push(store)
  const stop = store.onUnavailable(() => {
    throw new Error("An idle store must not report unavailability")
  })
  expect(typeof stop).toBe("function")
  await store.write(["record"], { value: 1 })
  expect(await store.read<{ value: number }>(["record"])).toEqual({ value: 1 })
  await store.close()
})
