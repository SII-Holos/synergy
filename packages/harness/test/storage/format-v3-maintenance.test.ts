import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StorageFormatV3Migration } from "../../src/storage/format-v3-migration"
import { StorageIncrementalVacuum } from "../../src/storage/incremental-vacuum"
import { runMigrations } from "../../src/migration"
import { createV2Store, inspect } from "./format-v3-fixture"

test("format 3 waits for deferred vacuum conversion and completes in the maintenance window", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "format-v3-maintenance-"))
  const filename = path.join(root, "agent.sqlite")
  const namespace = "maintenance"
  createV2Store({
    filename,
    namespace,
    records: [{ key: ["fixture", "record"], body: JSON.stringify({ kept: true }) }],
  })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace, filename })
  try {
    await Storage.provide({ store, artifactDirectory: root }, async () => {
      await runMigrations({ targetDomain: "storage", output: "silent" })
      expect(await store.incrementalVacuumEnabled()).toBe(false)
      expect(inspect(filename, namespace).version()).toBe(2)
      expect(await store.read(StoragePath.metaMigrationLogDomain("storage"))).not.toHaveProperty(
        StorageFormatV3Migration.id,
      )
      await runMigrations({ targetDomain: "storage", maintenance: true, output: "silent" })
      expect(await store.incrementalVacuumEnabled()).toBe(true)
      expect(inspect(filename, namespace).version()).toBe(3)
      const ledger = await store.read(StoragePath.metaMigrationLogDomain("storage"))
      expect(ledger).toHaveProperty(StorageIncrementalVacuum.id)
      expect(ledger).toHaveProperty(StorageFormatV3Migration.id)
      expect(await store.read(["fixture", "record"])).toEqual({ kept: true })
    })
  } finally {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
