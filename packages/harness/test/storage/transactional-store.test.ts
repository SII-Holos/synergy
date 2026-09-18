import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
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

    test("bulk writes preserve revisions, tree identity, tombstones and rollback checkpoints", async () => {
      const store = await open()
      const owner = ["sessions", "scope", "bulk", "info"]
      const first = ["sessions", "scope", "bulk", "rollout", "journal", "events", "0001"]
      await store.transaction(async (tx) => {
        await tx.writeMany([
          { key: owner, value: { id: "bulk" } },
          { key: first, value: { event: 1 } },
          { key: ["notes", "a/b"], value: 1 },
          { key: ["notes", "a", "b"], value: 2 },
        ])
      })
      expect(await store.scan(["notes"])).toEqual(["a", "a/b"])
      await store.transaction(async (tx) => {
        await tx.writeMany([{ key: first, value: { event: 2 } }])
        expect((await tx.versioned(first)).revision).toBe(2n)
      })
      await expect(
        store.transaction(async (tx) => {
          await tx.writeMany([{ key: first, value: { event: 3 } }])
          await tx.write(["storage_import", "cursor"], { offset: 3 })
          throw new Error("interrupted batch")
        }),
      ).rejects.toThrow("interrupted batch")
      expect(await store.read<{ event: number }>(first)).toEqual({ event: 2 })
      expect(await store.readMany([["storage_import", "cursor"]])).toEqual([undefined])
      await store.remove(owner)
      await expect(
        store.transaction((tx) =>
          tx.writeMany([
            ...Array.from({ length: 130 }, (_, index) => ({ key: ["rollback-batch", String(index)], value: true })),
            { key: first, value: { event: 4 } },
          ]),
        ),
      ).rejects.toMatchObject({ name: "StorageConflictError" })
      expect(await store.scan(["rollback-batch"])).toEqual([])
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

    test("bulk writes split large encoded records and keep the checkpoint atomic", async () => {
      const store = await open()
      const payload = randomBytes(9 * 1024 * 1024).toString("base64")
      const entries = Array.from({ length: 3 }, (_, index) => ({
        key: ["large-batch", String(index)],
        value: { payload, index },
      }))
      await store.transaction(async (tx) => {
        await tx.writeMany(entries)
        await tx.write(["large-checkpoint"], { cursor: 3 })
      })
      for (const entry of entries) expect(await store.read<typeof entry.value>(entry.key)).toEqual(entry.value)
      await expect(
        store.transaction(async (tx) => {
          await tx.writeMany(entries.map((entry) => ({ ...entry, value: { ...entry.value, changed: true } })))
          await tx.write(["large-checkpoint"], { cursor: 6 })
          throw new Error("interrupt after large writes")
        }),
      ).rejects.toThrow("interrupt after large writes")
      expect(await store.read<{ cursor: number }>(["large-checkpoint"])).toEqual({ cursor: 3 })
      for (const entry of entries) expect(await store.read<typeof entry.value>(entry.key)).toEqual(entry.value)
    }, 30_000)

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

    test("traversal reports a child for any live descendant and drops tombstoned subtrees", async () => {
      const store = await open()
      await store.write(["tree", "live", "deep", "leaf"], { value: 1 })
      await store.write(["tree", "gone", "deep", "leaf"], { value: 2 })
      await store.write(["tree", "gone", "deep"], { value: 3 })
      await store.write(["tree", "kept", "leaf"], { value: 4 })
      expect(await store.scan(["tree"])).toEqual(["gone", "kept", "live"])
      expect(await store.list(["tree"])).toEqual([
        ["tree", "gone", "deep"],
        ["tree", "gone", "deep", "leaf"],
        ["tree", "kept", "leaf"],
        ["tree", "live", "deep", "leaf"],
      ])
      await store.removeTree(["tree", "gone"])
      expect(await store.scan(["tree"])).toEqual(["kept", "live"])
      expect(await store.scan(["tree", "gone"])).toEqual([])
      expect(await store.list(["tree"])).toEqual([
        ["tree", "kept", "leaf"],
        ["tree", "live", "deep", "leaf"],
      ])
      expect(await store.read<Record<string, unknown>>(["tree", "live", "deep", "leaf"])).toEqual({ value: 1 })
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

    test("cursor pages preserve tied ordering, tombstones and complete exports", async () => {
      const store = await open()
      await store.transaction(async (tx) => {
        for (let index = 0; index < 40; index++) {
          const key = [index % 2 ? "page-first" : "page-second", String(index), String(index % 3)]
          await tx.write(key, { index })
          if (index % 7 === 0) await tx.remove(key)
        }
      })
      for (const kind of [undefined, "page-first", "page-second"]) {
        for (const descending of [false, true]) {
          const expected = await store.query({ kind, descending, limit: 100 })
          const actual = []
          let after: string[] | undefined
          for (;;) {
            const page = await store.query({ kind, descending, after, limit: 3 })
            if (!page.length) break
            actual.push(...page)
            after = page.at(-1)!.key
            expect(actual.length).toBeLessThanOrEqual(expected.length)
          }
          expect(actual).toEqual(expected)
        }
      }
      const first = await store.query({ kind: "page-first", limit: 3 })
      const cursor = first.at(-1)!.key
      const following = await store.query({ kind: "page-first", after: cursor, limit: 3 })
      await store.remove(cursor)
      expect(await store.query({ kind: "page-first", after: cursor, limit: 3 })).toEqual(following)
      const expected = await store.query({ limit: 100 })
      const exported = await store.snapshot(async (tx) => Array.fromAsync(tx.exportEntries()))
      expect(exported).toHaveLength(expected.length)
      expect(new Set(exported.map((entry) => entry.type === "record" && JSON.stringify(entry.key)))).toEqual(
        new Set(expected.map((record) => JSON.stringify(record.key))),
      )
      expect((await store.verify()).records).toBe(expected.length)
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

test("sqlite keeps the database and WAL sidecars owner-only", async () => {
  const filename = path.join(root, "permissions.sqlite")
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "permissions", filename })
  try {
    await store.write(["record"], { value: 1 })
    const mode = async (suffix: string) => (await fs.stat(`${filename}${suffix}`)).mode & 0o777
    if (process.platform !== "win32") {
      expect(await mode("")).toBe(0o600)
      expect(await mode("-wal")).toBe(0o600)
      expect(await mode("-shm")).toBe(0o600)
    }
  } finally {
    await store.close()
  }
})
