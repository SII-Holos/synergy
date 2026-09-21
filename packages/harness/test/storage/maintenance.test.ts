import { expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { Database } from "bun:sqlite"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { beginStorageMaintenance, observeStorageMaintenance } from "../../src/storage/maintenance-progress"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import type { SqliteRequest } from "../../src/storage/sql-contract"
import type { StorageMaintenanceEvent } from "@ericsanchezok/synergy-util/runtime-startup"

test("observes real opening DDL, VACUUM, verification and failed DDL outside the operation context", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "agent.sqlite")
  initializeSqliteEngine()
  const legacy = new Database(filename)
  legacy.exec("CREATE TABLE seed (body TEXT)")
  legacy.exec("INSERT INTO seed VALUES ('preserved')")
  legacy.close()
  const events: StorageMaintenanceEvent[] = []
  const context = new AsyncLocalStorage<boolean>()
  await observeStorageMaintenance(
    () =>
      context.run(true, async () => {
        const store = await TransactionalStore.open({ backend: "sqlite", namespace: "maintenance", filename })
        try {
          await store.maintain({ operation: "enable-incremental-vacuum" })
          expect((await store.verify()).issues).toEqual([])
          await store.dropIndexIfExists("storage_records_owner")
          await expect(store.maintainDdl("CREATE INDEX broken ON absent(x)", "create-index")).rejects.toThrow()
        } finally {
          await store.close()
        }
      }),
    (event) => {
      expect(context.getStore()).toBeUndefined()
      events.push(event)
    },
  )
  const starts = events.filter((event) => event.state === "started")
  expect(starts.map((event) => event.operation)).toContain("vacuum")
  expect(starts.map((event) => event.operation)).toContain("integrity-check")
  expect(starts.map((event) => event.operation)).toContain("drop-index")
  expect(starts[0]?.operation).toBe("create-index")
  expect(starts.every((event) => event.timeoutMs >= 690_000)).toBe(true)
  expect(events.filter((event) => event.state === "stage").map((event) => event.stage)).toEqual([
    "checkpoint-before",
    "rewrite",
    "checkpoint-after",
  ])
  for (const start of starts) {
    const terminal = events.filter((event) => event.id === start.id && ["completed", "failed"].includes(event.state))
    expect(terminal).toHaveLength(1)
    expect(events.indexOf(start)).toBeLessThan(events.indexOf(terminal[0]!))
  }
  expect(events.at(-1)?.state).toBe("failed")
  expect(JSON.stringify(events)).not.toContain(filename)
  expect(JSON.stringify(events)).not.toContain("absent")
  const read = new Database(filename, { readonly: true })
  expect(read.query("SELECT body FROM seed").get()).toEqual({ body: "preserved" })
  read.close()
})

test("worker loss emits one failed maintenance event and rejects the pending operation", async () => {
  await using tmp = await tmpdir()
  const driver = await SqliteDriver.open(path.join(tmp.path, "agent.sqlite"))
  const worker = (driver as unknown as { worker: Bun.Subprocess }).worker
  const send = worker.send.bind(worker)
  const dispatched = Promise.withResolvers<void>()
  const events: StorageMaintenanceEvent[] = []
  worker.send = (message: SqliteRequest) => {
    if (message.maintenance) dispatched.resolve()
    else send(message)
  }
  try {
    const pending = observeStorageMaintenance(
      () => driver.query("PRAGMA integrity_check", [], { maintenance: "integrity-check" }),
      (event) => events.push(event),
    )
    pending.catch(() => {})
    await dispatched.promise
    worker.kill()
    await expect(pending).rejects.toThrow("SQLite worker exited")
    expect(events.map((event) => event.state)).toEqual(["started", "failed"])
    expect(events[0]?.id).toBe(events[1]?.id)
  } finally {
    worker.send = send
    await driver.close().catch(() => {})
  }
})

test("observation bounds queued transitions and closes detached publishers", async () => {
  let retained: ReturnType<typeof beginStorageMaintenance>
  const events: StorageMaintenanceEvent[] = []
  await observeStorageMaintenance(
    async () => {
      retained = beginStorageMaintenance("reclaim", 690000)
      retained?.finish("completed")
      retained?.finish("failed")
    },
    (event) => events.push(event),
  )
  retained?.stage("rewrite")
  expect(events.map((event) => event.state)).toEqual(["started", "completed"])
  await expect(
    observeStorageMaintenance(
      async () => {
        for (let i = 0; i < 1025; i++) beginStorageMaintenance("create-index", 690000)
      },
      () => {},
    ),
  ).rejects.toThrow("queue exceeded")
  expect(beginStorageMaintenance("vacuum", 690000)).toBeUndefined()
})
