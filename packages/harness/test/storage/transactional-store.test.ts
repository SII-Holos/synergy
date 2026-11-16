import { afterAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import { TransactionalStore, type StoreTransaction } from "../../src/storage/transactional-store"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"

import { storageTestBackends } from "../support/storage-backends"

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

for (const backend of storageTestBackends()) {
  describe(`${backend} transactional records`, () => {
    async function open() {
      const namespace = crypto.randomUUID()
      const store = await TransactionalStore.open(
        backend === "sqlite"
          ? { backend, namespace, filename: path.join(root, `${namespace}.sqlite`) }
          : { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL!, maxConnections: 2 },
      )
      stores.push(store)
      return store
    }

    test("native finalizers accept only an original Store's live write callback", async () => {
      const target = await open()
      const foreign = await open()
      let escaped: StoreTransaction | undefined
      await target.transaction(async (tx) => {
        escaped = tx
        expect(() => target.assertWriteTransaction(tx)).not.toThrow()
        expect(() => foreign.assertWriteTransaction(tx)).toThrow("write callback")
        await tx.write(["original"], { value: true })
      })
      expect(() => target.assertWriteTransaction(escaped!)).toThrow("write callback")
      await target.snapshot(async (tx) => {
        expect(() => target.assertWriteTransaction(tx)).toThrow("write callback")
      })
      await expect(
        target.transaction(async (tx) => {
          escaped = tx
          target.assertWriteTransaction(tx)
          throw new Error("original rollback")
        }),
      ).rejects.toThrow("original rollback")
      expect(() => target.assertWriteTransaction(escaped!)).toThrow("write callback")
    })

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

    test("single Session writes read fresh owner and target metadata in one native dispatch without transferring bodies", async () => {
      const store = await open()
      const owner = ["sessions", "scope", "metadata-work", "info"]
      const payload = randomBytes(16 * 1024).toString("base64")
      const records = Array.from({ length: 8 }, (_, index) => [...owner.slice(0, 3), "messages", String(index), "info"])
      await store.transaction(async (tx) => {
        await tx.write(owner, { id: "metadata-work", payload })
        for (const [index, key] of records.entries()) await tx.write(key, { index, pass: -1, payload })
      })
      let reads = 0
      let bodyBytes = 0
      await store.transaction(async (tx) => {
        const connection = tx.raw
        const query = connection.query
        using observed = spyOn(connection, "query").mockImplementation(
          async <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
            const rows = await query<Row>(statement, values, options)
            if (/^SELECT\b/i.test(statement)) {
              reads++
              for (const row of rows)
                bodyBytes +=
                  typeof row.body === "string"
                    ? Buffer.byteLength(row.body)
                    : row.body instanceof Uint8Array
                      ? row.body.byteLength
                      : 0
            }
            return rows
          },
        )
        for (let pass = 0; pass < 2; pass++)
          for (const [index, key] of records.entries())
            await tx.write(key, { index, pass, payload }, { expectedRevision: BigInt(pass + 1) })
      })
      for (const [index, key] of records.entries()) {
        expect(await store.versioned(key)).toMatchObject({ value: { index, pass: 1, payload }, revision: 3n })
      }
      expect(await store.read(owner)).toEqual({ id: "metadata-work", payload })
      await store.write(owner, { id: "metadata-work", payload, current: true })
      expect((await store.versioned(owner)).revision).toBe(2n)
      console.info("SESSION_SINGLE_WRITE_METADATA_WORK", JSON.stringify({ writes: 16, reads, bodyBytes }))
      expect(reads).toBe(16)
      expect(bodyBytes).toBe(0)
    })

    test("single Session write metadata retains tombstone before collision and CAS errors with complete rollback", async () => {
      const store = await open()
      const owner = ["sessions", "scope", "metadata-errors", "info"]
      const child = [...owner.slice(0, 3), "messages", "message", "info"]
      await store.transaction(async (tx) => {
        await tx.write(owner, { id: "metadata-errors" })
        await tx.write(child, { value: "original" })
      })
      const collision = () =>
        store.transaction(async (tx) => {
          await tx.raw.query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
            JSON.stringify(["another-owner"]),
            store.options.namespace,
            JSON.stringify(child),
          ])
          await tx.write(child, { value: "invalid" }, { expectedRevision: 999n })
        })
      expect(await failure(collision())).toMatchObject({
        name: "StorageIntegrityError",
        message: "Logical key identity collision",
      })
      expect(await store.versioned(child)).toMatchObject({ value: { value: "original" }, revision: 1n })
      expect(await failure(store.transaction((tx) => tx.write(child, {}, { expectedRevision: 999n })))).toMatchObject({
        name: "StorageConflictError",
        message: "Storage revision changed",
      })
      await store.remove(owner)
      expect(await failure(collision())).toMatchObject({
        name: "StorageConflictError",
        message: "A deleted record cannot be revived by a delayed writer",
      })
      expect(await failure(store.write([...child, ""], {}))).toMatchObject({
        name: "StorageConflictError",
        message: "A deleted record cannot be revived by a delayed writer",
      })
      expect(await store.versioned(child)).toMatchObject({ value: { value: "original" }, revision: 1n })
    })

    test("single Session writes observe original guard mutations and retain the later publication check", async () => {
      const store = await open()
      const owner = ["sessions", "scope", "metadata-guard", "info"]
      const child = [...owner.slice(0, 3), "messages", "message", "info"]
      await store.transaction(async (tx) => {
        await tx.write(owner, { id: "metadata-guard" })
        await tx.write(child, { value: "original" })
      })
      let guarded = false
      expect(
        await failure(
          store.transaction(async (tx) => {
            tx.guardMutations(async (keys) => {
              if (guarded || !keys.some((key) => JSON.stringify(key) === JSON.stringify(child))) return
              guarded = true
              await tx.write(child, { value: "guard changed target" })
            })
            await tx.write(child, { value: "stale caller" }, { expectedRevision: 1n })
          }),
        ),
      ).toMatchObject({ name: "StorageConflictError", message: "Storage revision changed" })
      expect(guarded).toBe(true)
      expect(await store.versioned(child)).toMatchObject({ value: { value: "original" }, revision: 1n })
      const denied = new Error("original metadata guard denied")
      let deniedReads = 0
      expect(
        await failure(
          store.transaction(async (tx) => {
            const query = tx.raw.query
            using observed = spyOn(tx.raw, "query").mockImplementation(
              <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
                if (/^SELECT\b/i.test(statement)) deniedReads++
                return query<Row>(statement, values, options)
              },
            )
            tx.guardMutations(async () => {
              throw denied
            })
            await tx.write(child, { value: "denied" })
          }),
        ),
      ).toBe(denied)
      expect(deniedReads).toBe(0)
      for (const deleted of [false, true]) {
        if (deleted) await store.remove(owner)
        const error = await failure(
          store.transaction(async (tx) => {
            let installing = false
            tx.guardMutations(async (keys) => {
              if (installing || !keys.some((key) => JSON.stringify(key) === JSON.stringify(child))) return
              installing = true
              await tx.write(["compat_pending", "metadata-guard"], { retained: true })
              tx.restrictToPublishedOwners()
              await tx.raw.query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
                JSON.stringify(["another-owner"]),
                store.options.namespace,
                JSON.stringify(child),
              ])
            })
            await tx.write(child, { value: "blocked" }, { expectedRevision: 999n })
          }),
        )
        expect(error).toMatchObject(
          deleted
            ? { name: "StorageConflictError", message: "A deleted record cannot be revived by a delayed writer" }
            : { name: "SessionPreparingError" },
        )
        expect(await store.readMany([["compat_pending", "metadata-guard"]])).toEqual([undefined])
        expect(await store.versioned(child)).toMatchObject({ value: { value: "original" }, revision: 1n })
      }
    })

    test("single Session writes retain row-phase publication admission after native metadata delivery", async () => {
      for (const mode of ["unrestricted", "late-publication", "late-publication-before-collision"] as const) {
        const store = await open()
        const owner = ["sessions", "scope", "metadata-late-publication", "info"]
        const child = [...owner.slice(0, 3), "messages", "message", "info"]
        await store.transaction(async (tx) => {
          await tx.write(owner, { id: "metadata-late-publication" })
          await tx.write(child, { value: "original" })
          await tx.write(["compat_pending", "metadata-late-publication"], { retained: true })
          if (mode === "late-publication-before-collision")
            await tx.raw.query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
              JSON.stringify(["another-logical-key"]),
              store.options.namespace,
              JSON.stringify(child),
            ])
        })
        let reachedNativeRead = false
        let observedDelivery = false
        let restricted = false
        let mutationAfterRestriction = false
        const outcome = await store
          .transaction(async (tx) => {
            const connection = tx.raw
            const query = connection.query
            const entered = Promise.withResolvers<{ delivery: Promise<SqlRow[]> }>()
            const release = Promise.withResolvers<void>()
            let held = false
            using observed = spyOn(connection, "query").mockImplementation(
              <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
                if (restricted && /^INSERT INTO storage_(?:nodes|records)\b/i.test(statement))
                  mutationAfterRestriction = true
                const native = query<Row>(statement, values, options)
                const parentOrMetadata =
                  statement === "SELECT body FROM storage_records WHERE namespace = ? AND key_id = ?" ||
                  statement.startsWith(
                    "SELECT key_id, key_text, revision, CASE WHEN body IS NULL THEN 1 ELSE 0 END AS deleted FROM storage_records ",
                  )
                if (!parentOrMetadata || held) return native
                held = true
                const original: Promise<Row[]> = native.then(async (rows) => {
                  reachedNativeRead = true
                  entered.resolve({ delivery: original })
                  await release.promise
                  return rows
                })
                return original
              },
            )
            const pending = tx.write(child, { value: "caller" }, { expectedRevision: 1n }).then(
              () => ({ kind: "resolved" as const }),
              (error: unknown) => ({ kind: "rejected" as const, error }),
            )
            try {
              const reached = await Promise.race([
                entered.promise.then(({ delivery }) => ({ kind: "held" as const, delivery })),
                pending.then((result) => ({ kind: "early" as const, result })),
              ])
              if (reached.kind === "early") {
                if (reached.result.kind === "rejected") throw reached.result.error
                throw new Error("The original native parent or metadata read was not reached")
              }
              const caller = reached.delivery.then(() => {
                observedDelivery = true
                if (mode === "unrestricted") return
                tx.restrictToPublishedOwners()
                restricted = true
              })
              release.resolve()
              await caller
              const result = await pending
              if (result.kind === "rejected") throw result.error
            } finally {
              release.resolve()
              await pending
            }
          })
          .then(
            () => ({ kind: "resolved" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          )
        expect(reachedNativeRead).toBe(true)
        expect(observedDelivery).toBe(true)
        if (mode === "unrestricted") {
          expect(restricted).toBe(false)
          expect(outcome).toEqual({ kind: "resolved" })
          expect(await store.versioned(child)).toMatchObject({ value: { value: "caller" }, revision: 2n })
        } else {
          expect(restricted).toBe(true)
          expect(outcome).toMatchObject({ kind: "rejected", error: { name: "SessionPreparingError" } })
          expect(mutationAfterRestriction).toBe(false)
          if (mode === "late-publication")
            expect(await store.versioned(child)).toMatchObject({ value: { value: "original" }, revision: 1n })
        }
      }
    })

    test("single Session metadata remains fresh across a held original publication read and same-transaction typed or raw writes", async () => {
      for (const mode of ["typed-revision", "raw-revision", "raw-key-repair"] as const) {
        const store = await open()
        const owner = ["sessions", "scope", "metadata-interleave", "info"]
        const child = [...owner.slice(0, 3), "messages", "message", "info"]
        await store.transaction(async (tx) => {
          await tx.write(owner, { id: "metadata-interleave" })
          await tx.write(child, { value: "original" })
          await tx.write(["compat_pending", "unrelated-metadata-owner"], { retained: true })
        })
        await store.transaction(async (tx) => {
          const connection = tx.raw
          if (mode === "raw-key-repair")
            await connection.query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
              JSON.stringify(["temporary-key-mismatch"]),
              store.options.namespace,
              JSON.stringify(child),
            ])
          tx.restrictToPublishedOwners()
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const query = connection.query
          let admissions = 0
          using observed = spyOn(connection, "query").mockImplementation(
            async <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
              const rows = await query<Row>(statement, values, options)
              if (/^SELECT order_key FROM storage_records\b/i.test(statement) && ++admissions === 2) {
                entered.resolve()
                await release.promise
              }
              return rows
            },
          )
          const pending = tx.write(child, { value: "caller" }, { expectedRevision: 1n }).then(
            () => ({ kind: "resolved" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          )
          try {
            const reached = await Promise.race([
              entered.promise.then(() => ({ kind: "held" as const })),
              pending.then((outcome) => ({ kind: "early" as const, outcome })),
            ])
            if (reached.kind === "early") {
              if (reached.outcome.kind === "rejected") throw reached.outcome.error
              throw new Error("The original publication read was not reached")
            }
            if (mode === "typed-revision") await tx.write(child, { value: "newer" }, { expectedRevision: 1n })
            else if (mode === "raw-revision")
              await query(
                "UPDATE storage_records SET body = ?, revision = revision + 1 WHERE namespace = ? AND key_text = ?",
                [JSON.stringify({ value: "newer" }), store.options.namespace, JSON.stringify(child)],
              )
            else
              await query("UPDATE storage_records SET key_text = ? WHERE namespace = ? AND key_text = ?", [
                JSON.stringify(child),
                store.options.namespace,
                JSON.stringify(["temporary-key-mismatch"]),
              ])
          } finally {
            release.resolve()
            await pending
          }
          const outcome = await pending
          if (mode === "raw-key-repair") expect(outcome).toEqual({ kind: "resolved" })
          else {
            expect(outcome.kind).toBe("rejected")
            if (outcome.kind === "rejected")
              expect(outcome.error).toMatchObject({ name: "StorageConflictError", message: "Storage revision changed" })
          }
        })
        expect(await store.versioned(child)).toMatchObject({
          value: { value: mode === "raw-key-repair" ? "caller" : "newer" },
          revision: 2n,
        })
      }
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
      await expect(
        store.transaction((tx) => tx.insertHistorical([...first.slice(0, -1), "0002"], {}, 1)),
      ).rejects.toMatchObject({ name: "StorageConflictError" })
      await expect(
        store.transaction((tx) => tx.rewriteEncodings([{ key: first, value: {}, expected: { event: 2 } }])),
      ).rejects.toMatchObject({
        name: "StorageConflictError",
      })
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

    test("encoding batches retain revisions, reject changed evidence and seek only their keys", async () => {
      const store = await open()
      const entries = Array.from({ length: 128 }, (_, index) => ({
        key: ["encoding", String(index)],
        value: { value: index },
        expected: { value: index },
      }))
      await store.transaction((tx) => tx.writeMany(entries))
      await store.transaction(async (tx) => {
        using query = spyOn(tx.raw, "query")
        await tx.rewriteEncodings(entries.map((entry) => ({ ...entry, value: { encoded: entry.value.value } })))
        if (backend === "sqlite") {
          const update = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE storage_records"))!
          initializeSqliteEngine()
          const db = new Database(store.sqliteFilename!, { readonly: true })
          const statement = db.prepare<{ detail: string }, import("bun:sqlite").SQLQueryBindings[]>(
            "EXPLAIN QUERY PLAN " + update[0],
          )
          try {
            const plan = statement.all(...(update[1] ?? []))
            expect(plan.some((row) => row.detail.includes("key_id=?"))).toBe(true)
          } finally {
            statement.finalize()
            db.close()
          }
        }
        expect((await tx.versioned(entries[0].key)).revision).toBe(1n)
      })
      await expect(store.transaction((tx) => tx.rewriteEncodings(entries))).rejects.toMatchObject({
        name: "StorageConflictError",
      })
      expect(await store.read(entries.at(-1)!.key)).toEqual({ encoded: 127 })
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
      await store.snapshot(async (tx) => {
        expect((await tx.childKeys({ prefix: ["a"], includeBranches: true })).keys).toEqual([
          ["a", "b"],
          ["a", "b/c"],
          ["a", "other"],
        ])
        expect((await tx.childKeys({ prefix: ["a"] })).keys).toEqual([
          ["a", "b/c"],
          ["a", "other"],
        ])
      })
      expect(await store.list(["a", "b"])).toEqual([["a", "b", "c"]])
      await store.removeTree(["a", "b"])
      expect(await store.scan(["a"])).toEqual(["b/c", "other"])
      expect((await store.snapshot((tx) => tx.childKeys({ prefix: ["a"], includeBranches: true }))).keys).toEqual([
        ["a", "b/c"],
        ["a", "other"],
      ])
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

    test("prefix pages preserve exact segments, ordering, bounds and deleted cursors", async () => {
      const store = await open()
      const prefix = ["usage_time", "scope", 'operation_A%_"雪🧭']
      await store.transaction(async (tx) => {
        for (let index = 0; index < 45; index++) {
          for (const owner of [prefix[2], prefix[2].toLowerCase(), prefix[2] + "suffix"]) {
            await tx.write([prefix[0], prefix[1], owner, String(index).padStart(3, "0")], { index })
          }
        }
        await tx.remove([...prefix, "010"])
      })
      for (const descending of [false, true]) {
        const query = { kind: "usage_time", prefix, descending, orderFrom: "005", orderTo: "042" }
        const expected = await store.query({ ...query, limit: 100 })
        expect(expected).toHaveLength(36)
        expect(expected.every((row) => row.key[2] === prefix[2])).toBe(true)
        const actual = []
        let after: string[] | undefined
        for (;;) {
          const page = await store.query({ ...query, after, limit: 4 })
          expect(await store.snapshot((tx) => tx.queryKeys({ ...query, after, limit: 4 }))).toEqual(
            page.map((row) => row.key),
          )
          if (!page.length) break
          actual.push(...page)
          after = page.at(-1)!.key
        }
        expect(actual).toEqual(expected)
        expect(await store.snapshot((tx) => tx.count(query))).toBe(36)
      }
      const query = { kind: "usage_time", prefix, limit: 4 }
      const first = await store.query(query)
      const after = first.at(-1)!.key
      const next = await store.query({ ...query, after })
      await store.remove(after)
      expect(await store.query({ ...query, after })).toEqual(next)
      expect(await store.query({ prefix: [...prefix, "missing"] })).toEqual([])
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

test.skipIf(!storageTestBackends().includes("sqlite"))(
  "sqlite keeps the database and WAL sidecars owner-only",
  async () => {
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
  },
)
