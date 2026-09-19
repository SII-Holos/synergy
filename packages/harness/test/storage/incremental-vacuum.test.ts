import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { StorageIncrementalVacuum } from "../../src/storage/incremental-vacuum"
import { SqliteMaintenance } from "../../src/storage/sqlite-maintenance"

async function root() {
  return fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "incremental-vacuum-"))
}

function autoVacuum(filename: string) {
  const db = new Database(filename, { readonly: true })
  try {
    return SqliteMaintenance.autoVacuumMode(db)
  } finally {
    db.close(false)
  }
}

test("a new authoritative database already uses incremental auto-vacuum", async () => {
  const directory = await root()
  const filename = path.join(directory, "agent.sqlite")
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "fresh", filename })
  try {
    await store.write(["storage_meta", "identity"], { storeID: "fresh" })
    expect(autoVacuum(filename)).toBe("incremental")
  } finally {
    await store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("migrates an existing database once and is a no-op when already incremental", async () => {
  const directory = await root()
  const filename = path.join(directory, "agent.sqlite")
  // A database written before this change: no auto_vacuum declaration, so
  // SQLite records mode NONE in its header.
  const legacy = new Database(filename, { create: true })
  legacy.exec("PRAGMA journal_mode=WAL")
  legacy.exec("CREATE TABLE seed (id INTEGER PRIMARY KEY, body TEXT)")
  for (let index = 0; index < 2000; index++) legacy.query("INSERT INTO seed(body) VALUES (?)").run("x".repeat(200))
  legacy.exec("DELETE FROM seed WHERE id < 1000")
  legacy.close(true)
  expect(autoVacuum(filename)).toBe("none")

  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "upgrade", filename })
  try {
    const first = await Storage.provide({ store, artifactDirectory: directory }, () => StorageIncrementalVacuum.run())
    expect(first.autoVacuum).toBe("incremental")
    expect(first.changed).toBe(true)
    // The rewrite reclaims pages freed before the conversion.
    expect(first.freelistPages).toBe(0)
    expect(autoVacuum(filename)).toBe("incremental")

    const second = await Storage.provide({ store, artifactDirectory: directory }, () => StorageIncrementalVacuum.run())
    expect(second.autoVacuum).toBe("incremental")
    expect(second.changed).toBe(false)
  } finally {
    await store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 60000)

test("reclaiming released pages keeps records readable and reports freed pages", async () => {
  const directory = await root()
  const filename = path.join(directory, "agent.sqlite")
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "reclaim", filename })
  try {
    const keys: string[][] = []
    for (let index = 0; index < 200; index++) {
      const key = ["sessions", "scope", `ses_${index}`, "info"]
      keys.push(key)
      await store.write(key, { id: `ses_${index}`, padding: "y".repeat(4096) })
    }
    for (let index = 0; index < 150; index++) await store.removeTree(keys[index])

    const result = await store.maintain({ operation: "reclaim", maxPages: 4096 })
    expect(result.autoVacuum).toBe("incremental")
    expect(result.changed).toBe(true)
    expect(result.releasedPages).toBeGreaterThan(0)

    // Freed pages must not disturb the records that remain.
    expect(await store.read(["sessions", "scope", "ses_199", "info"])).toMatchObject({ id: "ses_199" })
    await expect(store.read(["sessions", "scope", "ses_0", "info"])).rejects.toBeInstanceOf(Storage.NotFoundError)
  } finally {
    await store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a postgres store reports nothing to maintain instead of failing", async () => {
  const url = process.env.SYNERGY_TEST_POSTGRES_URL
  if (!url) return
  const namespace = crypto.randomUUID()
  const store = await TransactionalStore.open({ backend: "postgres", namespace, url })
  try {
    expect(await store.maintain({ operation: "enable-incremental-vacuum" })).toEqual({
      changed: false,
      autoVacuum: "none",
      releasedPages: 0,
      freelistPages: 0,
    })
  } finally {
    await store.close()
  }
})
