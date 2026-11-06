import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
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

test("offline backup copies a checkpointed database while fencing later writes", async () => {
  await using tmp = await tmpdir()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "backup",
    filename: path.join(tmp.path, "agent.sqlite"),
  })
  const filename = path.join(tmp.path, "backup.sqlite")
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const copy = fs.copyFile
  using copying = spyOn(fs, "copyFile").mockImplementation(async (...args) => {
    entered.resolve()
    await release.promise
    await copy(...args)
  })
  let pending: Promise<void> | undefined
  try {
    await store.write(["snapshot"], "before")
    const events: StorageMaintenanceEvent[] = []
    const backup = observeStorageMaintenance(
      () => store.backupSqlite(filename),
      (event) => events.push(event),
    )
    expect(await Promise.race([backup.then(() => "finished"), entered.promise.then(() => "copying")])).toBe("copying")
    let written = false
    pending = store.write(["snapshot"], "after").then(() => {
      written = true
    })
    await Promise.resolve()
    expect(written).toBe(false)
    release.resolve()
    await backup
    expect(events.filter((event) => event.state === "started").map((event) => event.operation)).toEqual(["checkpoint"])
    await pending
    const snapshot = await TransactionalStore.open({ backend: "sqlite", namespace: "backup", filename, readonly: true })
    try {
      expect(await snapshot.read(["snapshot"])).toBe("before")
    } finally {
      await snapshot.close()
    }
    expect(await store.read(["snapshot"])).toBe("after")
    const existing = await store.backupSqlite(filename).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(existing).toBeInstanceOf(Error)
    expect(existing).toMatchObject({ code: "EEXIST" })
  } finally {
    release.resolve()
    await pending
    await store.close()
  }
})

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
          const invalid = await store.maintainDdl("CREATE INDEX broken ON absent(x)", "create-index").then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(invalid).toBeInstanceOf(Error)
          expect(invalid).toMatchObject({ code: "SQLITE_ERROR", message: expect.stringContaining("absent") })
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
  const worker = (driver as unknown as { reader: { worker: Bun.Subprocess } }).reader.worker
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
    const exited = await pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(exited).toBeInstanceOf(Error)
    expect(exited).toMatchObject({ message: expect.stringContaining("SQLite worker exited") })
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
