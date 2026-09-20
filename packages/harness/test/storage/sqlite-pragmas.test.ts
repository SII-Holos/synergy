import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { TransactionalStore } from "../../src/storage/transactional-store"

// Mirrors the worker's requests. `cache_size` has no compile-time cap, so the
// engine must report exactly this back; `mmap_size` may be clamped by
// SQLITE_MAX_MMAP_SIZE or unavailable on some platforms (and is deliberately
// not requested at all on Windows).
const REQUESTED_CACHE_SIZE_KIB = -65536
const REQUESTED_MMAP_SIZE_BYTES = 268435456

const roots: string[] = []
const drivers: SqliteDriver[] = []

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.close().catch(() => {})))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function number(row: Record<string, unknown> | undefined) {
  const value = Object.values(row ?? {})[0]
  return value === undefined ? undefined : Number(value)
}

async function openDriver() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "sqlite-pragmas-"))
  roots.push(root)
  const filename = path.join(root, "agent.sqlite")
  const driver = await SqliteDriver.open(filename)
  drivers.push(driver)
  return { driver, filename }
}

// The sizing pragmas are per connection, so only the worker's own connections
// can report what it actually asked for. Reading them through the driver is the
// read-back the worker itself performs on open.
async function writerSizing(driver: SqliteDriver) {
  const pragmas = await driver.transaction(async (tx) => ({
    synchronous: number((await tx.query("PRAGMA synchronous"))[0]),
    autoVacuum: number((await tx.query("PRAGMA auto_vacuum"))[0]),
    journalMode: String(Object.values((await tx.query("PRAGMA journal_mode"))[0])[0]),
    cacheSize: number((await tx.query("PRAGMA cache_size"))[0]),
    mmapSize: number((await tx.query("PRAGMA mmap_size"))[0]),
  }))
  return pragmas
}

async function readerSizing(driver: SqliteDriver) {
  return {
    cacheSize: number((await driver.query("PRAGMA cache_size"))[0]),
    mmapSize: number((await driver.query("PRAGMA mmap_size"))[0]),
  }
}

test("a fresh worker start keeps the authoritative durability and auto-vacuum settings", async () => {
  const { driver } = await openDriver()
  const pragmas = await writerSizing(driver)
  expect(pragmas.synchronous).toBe(2)
  expect(pragmas.autoVacuum).toBe(2)
  expect(pragmas.journalMode).toBe("wal")
})

test("both worker connections report the requested cache size and a memory map", async () => {
  const { driver } = await openDriver()
  const writer = await writerSizing(driver)
  const reader = await readerSizing(driver)

  expect(writer.cacheSize).toBe(REQUESTED_CACHE_SIZE_KIB)
  expect(reader.cacheSize).toBe(REQUESTED_CACHE_SIZE_KIB)
  if (process.platform === "win32") {
    // Windows cannot truncate a memory-mapped file, which would silently defeat
    // the incremental vacuum that governs this store's capacity.
    expect(writer.mmapSize).toBe(0)
    expect(reader.mmapSize).toBe(0)
    return
  }
  // A clamp against SQLITE_MAX_MMAP_SIZE is documented and still maps memory;
  // only an unmappable host may report zero.
  expect(writer.mmapSize).toBeGreaterThan(0)
  expect(writer.mmapSize).toBeLessThanOrEqual(REQUESTED_MMAP_SIZE_BYTES)
  expect(reader.mmapSize).toBeGreaterThan(0)
  expect(reader.mmapSize).toBeLessThanOrEqual(REQUESTED_MMAP_SIZE_BYTES)
})

test("a store opened for the first time starts and serves reads and writes", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "sqlite-pragmas-fresh-"))
  roots.push(root)
  const filename = path.join(root, "agent.sqlite")
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "fresh", filename })
  try {
    await store.write(["record"], { started: true })
    expect(await store.read<{ started: boolean }>(["record"])).toEqual({ started: true })
  } finally {
    await store.close()
  }
})
