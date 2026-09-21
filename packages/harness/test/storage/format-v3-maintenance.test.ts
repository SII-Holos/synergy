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
import { StorageReclamation } from "../../src/storage/format-reclamation"

test.each([false, true])(
  "format 3 requires maintenance even when incremental vacuum is %s",
  async (incrementalVacuum) => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "format-v3-maintenance-"))
    const filename = path.join(root, "agent.sqlite")
    const namespace = "maintenance"
    createV2Store({
      filename,
      namespace,
      incrementalVacuum,
      records: [{ key: ["fixture", "record"], body: JSON.stringify({ kept: true }) }],
    })
    const store = await TransactionalStore.open({ backend: "sqlite", namespace, filename })
    try {
      await Storage.provide({ store, artifactDirectory: root }, async () => {
        await runMigrations({ targetDomain: "storage", output: "silent" })
        expect(await store.incrementalVacuumEnabled()).toBe(incrementalVacuum)
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
        expect(await store.read<{ kept: boolean }>(["fixture", "record"])).toEqual({ kept: true })
      })
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test("a populated old database opens before optimization and reconciles a committed format without reclamation", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "format-v3-populated-"))
  const filename = path.join(root, "agent.sqlite")
  const namespace = "populated"
  const body = JSON.stringify({ evidence: "retained historical evidence ".repeat(80) })
  const records = Array.from({ length: 50_000 }, (_, index) => ({ key: ["fixture", String(index)], body }))
  createV2Store({ filename, namespace, incrementalVacuum: true, records })
  let store = await TransactionalStore.open({ backend: "sqlite", namespace, filename })
  try {
    await Storage.provide({ store, artifactDirectory: root }, async () => {
      await runMigrations({ targetDomain: "storage", output: "silent" })
      expect(store.keyEncodedAs).toBe("hex")
      expect(await StorageFormatV3Migration.state(store)).toBeUndefined()
      expect(await store.read<Record<string, string>>(["fixture", "49999"])).toEqual(JSON.parse(body))
      await StorageFormatV3Migration.run({ store })
      expect(await store.read(StoragePath.metaMigrationLogDomain("storage"))).not.toHaveProperty(
        StorageFormatV3Migration.id,
      )
    })
    await store.close()
    store = await TransactionalStore.open({ backend: "sqlite", namespace, filename })
    await Storage.provide({ store, artifactDirectory: root }, async () => {
      const steps: string[] = []
      await runMigrations({
        targetDomain: "storage",
        output: "silent",
        reporter: { started: ({ migration }) => steps.push(migration.id), summary() {} },
      })
      expect(steps).not.toContain(StorageFormatV3Migration.id)
      expect(await store.read(StoragePath.metaMigrationLogDomain("storage"))).toHaveProperty(
        StorageFormatV3Migration.id,
      )
      expect((await StorageReclamation.status(store)).reclaim).toMatchObject({ pending: true, releasedPages: 0 })
      expect((await store.verify()).issues).toEqual([])
      expect(await store.read<Record<string, string>>(["fixture", "49999"])).toEqual(JSON.parse(body))
    })
  } finally {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60_000)
