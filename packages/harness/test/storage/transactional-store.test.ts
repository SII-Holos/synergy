import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"

if (process.env.SYNERGY_REQUIRE_POSTGRES_TESTS === "1" && !process.env.SYNERGY_TEST_POSTGRES_URL)
  throw new Error("PostgreSQL contract tests require a real database")

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "transactional-store-"))
const stores: TransactionalStore[] = []
async function failure(task: Promise<unknown>) {
  return task.then(
    () => {
      throw new Error("Expected storage operation to fail")
    },
    (error: unknown) => error,
  )
}
afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()))
  await fs.rm(root, { recursive: true, force: true })
})

for (const backend of ["sqlite", ...(process.env.SYNERGY_TEST_POSTGRES_URL ? ["postgres"] : [])] as const) {
  describe(`${backend} transactional records`, () => {
    async function open() {
      const namespace = crypto.randomUUID()
      const store = await TransactionalStore.open(
        backend === "sqlite"
          ? { backend, namespace, filename: path.join(root, `${namespace}.sqlite`) }
          : { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! },
      )
      stores.push(store)
      return store
    }

    test("commits related records together and rolls back every mutation on failure", async () => {
      const store = await open()
      await store.transaction(async (tx) => {
        await tx.write(["sessions", "scope", "session", "info"], { title: "before", optional: { future: true } })
        await tx.write(["session_index", "session"], { scopeID: "scope" })
      })
      expect(
        await failure(
          store.transaction(async (tx) => {
            await tx.write(["sessions", "scope", "session", "info"], { title: "after" })
            await tx.remove(["session_index", "session"])
            throw new Error("abort operation")
          }),
        ),
      ).toMatchObject({ message: "abort operation" })
      expect(await store.read<Record<string, unknown>>(["sessions", "scope", "session", "info"])).toEqual({
        title: "before",
        optional: { future: true },
      })
      expect(await store.read<Record<string, unknown>>(["session_index", "session"])).toEqual({ scopeID: "scope" })
    })

    test("propagates asynchronous transaction rejection", async () => {
      const store = await open()
      await expect(
        store.transaction(async (tx) => {
          await tx.write(["rollback"], { value: 1 })
          throw new Error("transaction aborted")
        }),
      ).rejects.toThrow("transaction aborted")
    })

    test("serializes concurrent read-modify-write and preserves unknown fields", async () => {
      const store = await open()
      await store.write(["counter"], { count: 0, unknownOwner: { future: "retained" } })
      await Promise.all(
        Array.from({ length: 24 }, () =>
          store.transaction(async (tx) => {
            await tx.update<{ count: number }>(["counter"], (value) => {
              value.count++
            })
          }),
        ),
      )
      expect(await store.read<Record<string, unknown>>(["counter"])).toEqual({
        count: 24,
        unknownOwner: { future: "retained" },
      })
    })

    test("replays a committed operation receipt without running the command again", async () => {
      const store = await open()
      let calls = 0
      const execute = () =>
        store.transaction(
          async (tx) => {
            calls++
            await tx.write(["input"], { id: "message" })
            return { id: "message" }
          },
          { operationID: "delivery", requestHash: "same-input" },
        )
      expect(await execute()).toEqual({ id: "message" })
      expect(await execute()).toEqual({ id: "message" })
      expect(calls).toBe(1)
      expect(
        await failure(store.transaction(async () => "wrong", { operationID: "delivery", requestHash: "other-input" })),
      ).toMatchObject({ name: "StorageConflictError" })
    })

    test("only reports missing records as absent and keeps ordered batched reads", async () => {
      const store = await open()
      await store.write(["a"], { value: 1 })
      expect(await store.readMany([["missing"], ["a"], ["a"]])).toEqual([undefined, { value: 1 }, { value: 1 }])
      expect(await failure(store.read<Record<string, unknown>>(["missing"]))).toMatchObject({ name: "NotFoundError" })
      await store.close()
      expect(await failure(store.readMany([["a"]]))).toMatchObject({ name: "StorageClosedError" })
    })

    test("enumerates logical keys without path collisions and deletes complete trees", async () => {
      const store = await open()
      await store.write(["a", "b/c"], { value: 1 })
      await store.write(["a", "b", "c"], { value: 2 })
      await store.write(["a", "other"], { value: 3 })
      expect(await store.scan(["a"])).toEqual(["b", "b/c", "other"])
      expect(await store.list(["a", "b"])).toEqual([["a", "b", "c"]])
      await store.removeTree(["a", "b"])
      expect(await store.scan(["a"])).toEqual(["b/c", "other"])
      expect(await store.read<Record<string, unknown>>(["a", "b/c"])).toEqual({ value: 1 })
    })

    test("rejects stale revisions and never reuses the revision of deleted records", async () => {
      const store = await open()
      await store.write(["part"], { status: "running" })
      const before = await store.versioned(["part"])
      await store.write(["part"], { status: "completed" })
      expect(
        await failure(
          store.transaction((tx) => tx.write(["part"], { status: "running" }, { expectedRevision: before.revision })),
        ),
      ).toMatchObject({ name: "StorageConflictError" })
      await store.remove(["part"])
      await store.write(["part"], { status: "new" })
      expect((await store.versioned(["part"])).revision).toBeGreaterThan(before.revision)
    })

    test("records notifications in the same transaction and acknowledges them explicitly", async () => {
      const store = await open()
      expect(
        await failure(
          store.transaction(async (tx) => {
            await tx.enqueue({ id: "rolled-back", scopeID: "scope", type: "changed", payload: {} })
            throw new Error("abort")
          }),
        ),
      ).toMatchObject({ message: "abort" })
      expect(await store.pendingEvents()).toEqual([])
      await store.transaction(async (tx) => {
        await tx.write(["record"], { value: 1 })
        await tx.enqueue({ id: "event", scopeID: "scope", type: "changed", payload: { value: 1 } })
      })
      expect((await store.pendingEvents()).map((event) => event.id)).toEqual(["event"])
      await store.acknowledgeEvents(["event"])
      expect(await store.pendingEvents()).toEqual([])
    })
  })
}
