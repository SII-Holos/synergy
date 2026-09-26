import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { Storage } from "../../src/storage/storage"
import { StorageCompat } from "../../src/storage/compat"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SegmentedBackup } from "../../src/storage/segmented-backup"
import { SessionCompat } from "../../src/session/compat-import"

for (const category of ["retryable", "integrity"] as const) {
  test(`an active retry supersedes its previous ${category} failure until it settles`, () =>
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
          const backup = new SegmentedBackup(data, "retry-status")
          await backup.freeze()
          await StorageCompat.seedLocators(store, backup.sourceRoot, backup.backupID)
          const id = fixture.records[0].value.id
          const locator = (await StorageCompat.readLocator(store, id))!
          const error = { category, message: "Previous preparation failed" }
          await StorageCompat.writeLocator(store, { ...locator, error })
          expect(await SessionCompat.preparation(id)).toMatchObject({ state: "failed", error })
          expect(await SessionCompat.prepare(id)).toMatchObject({ state: "failed", error })
          const acquired = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const writer = store.transaction(async () => {
            acquired.resolve()
            await release.promise
          })
          await acquired.promise
          const importing = SessionCompat.ensureImported(id, true)
          try {
            for (const status of [
              await SessionCompat.preparation(id),
              await SessionCompat.prepare(id),
              await SessionCompat.prepare(id, true),
            ]) {
              expect(status.state).toBe("preparing")
              expect(status.error).toBeUndefined()
            }
            await expect(Storage.read(fixture.records[0].key)).rejects.toThrow("preparation")
          } finally {
            release.resolve()
            await writer
            await importing
            await SessionCompat.drain()
          }
          expect(await SessionCompat.preparation(id)).toMatchObject({ state: "ready", error: undefined })
          expect((await SessionCompat.stats()).imported).toBe(1)
          expect((await store.verify()).issues).toEqual([])
        })
      } finally {
        await store.close()
      }
    }))
}

afterRuntimeTests(() => runtime.close())
