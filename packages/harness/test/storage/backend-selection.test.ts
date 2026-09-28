import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestBackends, storageTestOptions } from "../support/storage-backends"

test("backend selection preserves local defaults and can require PostgreSQL alone", () => {
  expect(storageTestBackends({})).toEqual(["sqlite"])
  expect(storageTestBackends({ SYNERGY_TEST_POSTGRES_URL: "postgres://fixture" })).toEqual(["sqlite", "postgres"])
  expect(
    storageTestBackends({ SYNERGY_TEST_STORAGE_BACKEND: "postgres", SYNERGY_TEST_POSTGRES_URL: "postgres://fixture" }),
  ).toEqual(["postgres"])
  expect(
    storageTestBackends({ SYNERGY_TEST_STORAGE_BACKEND: "sqlite", SYNERGY_TEST_POSTGRES_URL: "postgres://fixture" }),
  ).toEqual(["sqlite"])
})

test("required PostgreSQL cannot silently fall back to SQLite or skip its contracts", () => {
  expect(() => storageTestBackends({ SYNERGY_REQUIRE_POSTGRES_TESTS: "1" })).toThrow("real database")
  expect(() => storageTestBackends({ SYNERGY_TEST_STORAGE_BACKEND: "postgres" })).toThrow("real database")
  expect(() => storageTestBackends({ SYNERGY_TEST_STORAGE_BACKEND: "unknown" })).toThrow("Unknown storage test backend")
  expect(() =>
    storageTestBackends({
      SYNERGY_REQUIRE_POSTGRES_TESTS: "1",
      SYNERGY_TEST_STORAGE_BACKEND: "sqlite",
      SYNERGY_TEST_POSTGRES_URL: "postgres://fixture",
    }),
  ).toThrow("requires PostgreSQL")
})

for (const backend of storageTestBackends()) {
  test(`${backend} selection exercises its real transactional store`, async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-backend-"))
    const options = storageTestOptions(
      { namespace: crypto.randomUUID(), filename: path.join(root, "records.sqlite") },
      { ...process.env, SYNERGY_TEST_STORAGE_BACKEND: backend },
    )
    const store = await TransactionalStore.open(options)
    try {
      expect(store.options.backend).toBe(backend)
      await store.write(["selection"], { backend, value: "committed" })
      await expect(
        store.transaction(async (tx) => {
          await tx.write(["selection"], { backend, value: "rolled back" })
          throw new Error("rollback")
        }),
      ).rejects.toThrow("rollback")
      expect(await store.read<{ backend: string; value: string }>(["selection"])).toEqual({
        backend,
        value: "committed",
      })
      expect(
        await Bun.file(options.backend === "sqlite" ? options.filename : path.join(root, "records.sqlite")).exists(),
      ).toBe(backend === "sqlite")
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
