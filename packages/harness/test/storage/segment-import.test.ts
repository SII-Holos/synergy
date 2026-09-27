import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { StorageCompat } from "../../src/storage/compat"
import { SegmentedBackup } from "../../src/storage/segmented-backup"
import { SessionCompat } from "../../src/session/compat-import"
import { UpgradeWork } from "../../src/storage/upgrade-work"

test("a cancelled segment keeps its source and can resume without duplicate records", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const fixture = await Bun.file(new URL("./fixtures/v3.0.22.json", import.meta.url)).json()
    for (const record of fixture.records.slice(0, 4)) {
      await Bun.write(path.join(data, ...record.key) + ".json", JSON.stringify(record.value))
    }
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: crypto.randomUUID(),
      filename: path.join(tmp.path, "target.sqlite"),
    })
    try {
      await Storage.provide({ store, artifactDirectory: data }, async () => {
        const backup = new SegmentedBackup(data, "test-segment")
        await backup.freeze()
        await StorageCompat.seedLocators(store, backup.sourceRoot, backup.backupID)
        const controller = new AbortController()
        controller.abort(new Error("interrupted segment"))
        const id = fixture.records[0].value.id
        await expect(
          UpgradeWork.run({ background: false, signal: controller.signal }, () => SessionCompat.requireImported(id)),
        ).rejects.toThrow("interrupted segment")
        expect(await Bun.file(path.join(backup.sourceRoot, ...fixture.records[0].key) + ".json").exists()).toBe(true)
        await SessionCompat.ensureImported(id)
        expect(await store.read(fixture.records[3].key)).toEqual(fixture.records[3].value)
        expect((await SessionCompat.stats()).imported).toBe(1)
        await SessionCompat.requireImported(id)
        expect((await SessionCompat.stats()).imported).toBe(1)
        expect((await store.verify()).issues).toEqual([])
      })
    } finally {
      await store.close()
    }
  }))

test("source drift after sealing never publishes staged records or deletes recovery input", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const fixture = await Bun.file(new URL("./fixtures/v3.0.22.json", import.meta.url)).json()
    for (const record of fixture.records.slice(0, 4))
      await Bun.write(path.join(data, ...record.key) + ".json", JSON.stringify(record.value))
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: crypto.randomUUID(),
      filename: path.join(tmp.path, "db"),
    })
    try {
      await Storage.provide({ store, artifactDirectory: data }, async () => {
        const backup = new SegmentedBackup(data, "source-drift")
        await backup.freeze()
        await StorageCompat.seedLocators(store, backup.sourceRoot, backup.backupID)
        const id = fixture.records[0].value.id
        const owner = (await StorageCompat.readLocator(store, id))!
        await backup.sealSession(owner)
        const file = path.join(backup.sourceRoot, ...fixture.records[0].key) + ".json"
        await Bun.write(file, JSON.stringify({ ...fixture.records[0].value, title: "external modification" }))
        await expect(SessionCompat.ensureImported(id)).rejects.toThrow("changed")
        await expect(Storage.read(fixture.records[0].key)).rejects.toThrow("preparation")
        expect((await StorageCompat.readLocator(store, id))?.status).toBe("partial")
        expect((await Bun.file(file).json()).title).toBe("external modification")
        await SessionCompat.prepare(id, true)
        await SessionCompat.drain()
        expect(await SessionCompat.preparation(id)).toMatchObject({ state: "failed", error: { category: "integrity" } })
      })
    } finally {
      await store.close()
    }
  }))

test("failed publication rolls back indexes and admission, then resumes from durable checkpoints", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const fixture = await Bun.file(new URL("./fixtures/v3.0.22.json", import.meta.url)).json()
    for (const record of fixture.records.slice(0, 4))
      await Bun.write(path.join(data, ...record.key) + ".json", JSON.stringify(record.value))
    const options = { backend: "sqlite" as const, namespace: crypto.randomUUID(), filename: path.join(tmp.path, "db") }
    let store = await TransactionalStore.open(options)
    try {
      await Storage.provide({ store, artifactDirectory: data }, async () => {
        const { SessionSegment } = await import("../../src/session/segment-import")
        const backup = new SegmentedBackup(data, "publication")
        await backup.freeze()
        await StorageCompat.seedLocators(store, backup.sourceRoot, backup.backupID)
        const locator = (await StorageCompat.readLocator(store, fixture.records[0].value.id))!
        await expect(
          Storage.withMigrationRecords(() =>
            SessionSegment.importOwner(locator, backup, false, {
              validate: async (value) => value,
              quarantine: async () => {
                throw new Error("Unexpected quarantine")
              },
              indexes: async () => {
                await Storage.write(["fixture-index"], true)
                throw new Error("interrupted publication")
              },
            }),
          ),
        ).rejects.toThrow("interrupted publication")
        expect(await store.readMany([["fixture-index"]])).toEqual([undefined])
        await expect(Storage.read(fixture.records[0].key)).rejects.toThrow("preparation")
      })
      await store.close()
      store = await TransactionalStore.open(options)
      await Storage.provide({ store, artifactDirectory: data }, async () => {
        await SessionCompat.ensureImported(fixture.records[0].value.id)
        expect(await Storage.read<unknown>(fixture.records[3].key)).toEqual(fixture.records[3].value)
        expect((await SessionCompat.stats()).imported).toBe(1)
        expect((await store.verify()).issues).toEqual([])
      })
    } finally {
      await store.close()
    }
  }))

afterRuntimeTests(() => runtime.close())
