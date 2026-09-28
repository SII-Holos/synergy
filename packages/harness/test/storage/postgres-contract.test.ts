import { afterAll, expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { StorageRecordsOwnerIndex } from "../../src/storage/owner-index"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestBackends } from "../support/storage-backends"
import { storageTestRuntime } from "../support/storage-runtime"

const postgresTest = test.skipIf(!storageTestBackends().includes("postgres"))
const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

async function fixture(body: (store: TransactionalStore) => Promise<void>) {
  await runtime.run(async () => {
    const store = await TransactionalStore.open({
      backend: "postgres",
      namespace: crypto.randomUUID(),
      url: process.env.SYNERGY_TEST_POSTGRES_URL!,
    })
    try {
      await body(store)
    } finally {
      await store.close()
    }
  })
}

postgresTest("PostgreSQL replacement deduplicates old shared packs", () =>
  fixture(async (store) => {
    const location = {
      pack: crypto.randomUUID() + ".pack",
      codec: "raw" as const,
      blockOffset: 0,
      blockBytes: 1,
      decodedBytes: 1,
      offset: 0,
      size: 1,
      sha256: "0".repeat(64),
    }
    await store.transaction(async (tx) => {
      const entries = Array.from({ length: 128 }, (_, n) => ({ key: ["blobs", String(n)], location }))
      await tx.writeArtifacts(entries)
      const replacement = { ...location, pack: crypto.randomUUID() + ".pack" }
      await tx.writeArtifacts(entries.map((entry) => ({ ...entry, location: replacement })))
      expect(await tx.artifactGarbage()).toEqual([{ pack: location.pack, used: false }])
      await tx.removeTree(["blobs"])
      expect((await tx.artifactGarbage()).map((entry) => entry.used)).toEqual([false, false])
    })
  }),
)

postgresTest("PostgreSQL owner index creation is idempotent and retains records", () =>
  fixture(async (store) => {
    await store.write(["record"], { value: "retained" })
    const handle = { store, artifactDirectory: process.env.SYNERGY_TEST_ROOT! }
    await expect(Storage.provide(handle, () => StorageRecordsOwnerIndex.run())).resolves.toBeUndefined()
    await expect(Storage.provide(handle, () => StorageRecordsOwnerIndex.run())).resolves.toBeUndefined()
    expect(await store.read<{ value: string }>(["record"])).toEqual({ value: "retained" })
  }),
)

postgresTest("PostgreSQL accepts the idempotent retired scope index drop", () =>
  fixture(async (store) => {
    await expect(store.dropIndexIfExists("storage_records_scope")).resolves.toBeUndefined()
    await expect(store.dropIndexIfExists("storage_records_scope")).resolves.toBeUndefined()
  }),
)

postgresTest("PostgreSQL reports no incremental vacuum work", () =>
  fixture(async (store) => {
    expect(await store.maintain({ operation: "enable-incremental-vacuum" })).toEqual({
      changed: false,
      autoVacuum: "none",
      releasedPages: 0,
      freelistPages: 0,
    })
  }),
)

postgresTest("PostgreSQL exposes unavailability subscriptions without failing ordinary writes", () =>
  fixture(async (store) => {
    const received: Error[] = []
    const stop = Storage.provide({ store, artifactDirectory: process.env.SYNERGY_TEST_ROOT! }, () =>
      Storage.onUnavailable((error) => received.push(error)),
    )
    try {
      await store.write(["record"], { value: 1 })
      expect(await store.read<{ value: number }>(["record"])).toEqual({ value: 1 })
      expect(received).toEqual([])
    } finally {
      stop()
    }
  }),
)
