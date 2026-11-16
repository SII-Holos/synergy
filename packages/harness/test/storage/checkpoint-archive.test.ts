import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Storage } from "../../src/storage/storage"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

test("a complete namespace checkpoint restores exact records and binary bytes into an independently fenced Home", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-archive-"))
    const source = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "source", "db") }),
    )
    const target = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "target", "db") }),
    )
    const key = randomBytes(32)
    const keys = {
      async current() {
        return { version: "recovery-one", key }
      },
      async resolve() {
        return key
      },
    }
    const bytes = randomBytes(5 * 1024 * 1024 + 3)
    try {
      const manifest = await Storage.provide(
        { store: source, artifactDirectory: path.join(root, "source", "content") },
        async () => {
          await Storage.write(["history", "unknown"], { future: { nested: ["retained", { value: 7 }] } })
          await Storage.write(["sensitive", "key"], { privateKey: "fixture-private-recovery-material" })
          await Storage.writeBinary(["attachments", "one"], bytes)
          await Storage.writeBinary(["attachments", "empty"], new Uint8Array())
          return StorageCheckpoint.exportArchive({
            directory: path.join(root, "archive"),
            archiveID: "archive-one",
            namespaceID: "service",
            buildVersion: "fixture-build",
            keys,
            protect: (entry) => entry.type === "record" && entry.key[0] === "sensitive",
          })
        },
      )
      expect(manifest.artifactReferences).toBe(2)
      expect(manifest.secretEntries).toBe(1)
      expect(await fs.readFile(path.join(root, "archive", "records.ndjson"), "utf8")).not.toContain(
        "fixture-private-recovery-material",
      )
      await Storage.provide({ store: target, artifactDirectory: path.join(root, "target", "content") }, async () => {
        await StorageCheckpoint.restoreArchive({
          directory: path.join(root, "archive"),
          keys,
          restoreID: "restore-one",
          finalize: async (tx) => {
            await tx.write(["recovery", "gate"], { paused: true, uniqueWriter: false })
          },
        })
        expect(await Storage.read(["history", "unknown"])).toEqual({ future: { nested: ["retained", { value: 7 }] } })
        expect(await Storage.read(["sensitive", "key"])).toEqual({ privateKey: "fixture-private-recovery-material" })
        expect(await Storage.readBinary(["attachments", "one"])).toEqual(bytes)
        expect(await Storage.readBinary(["attachments", "empty"])).toEqual(new Uint8Array())
        expect(await Storage.read(["recovery", "gate"])).toEqual({ paused: true, uniqueWriter: false })
        expect(await Storage.validateArtifacts(Storage.current())).toBe(2)
        expect(await Storage.query({ prefix: ["storage_checkpoint_staging"], limit: 1 })).toEqual([])
      })
    } finally {
      await source.close()
      await target.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))

test("missing bytes and wrong recovery keys never publish an ordinary restored record", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-incomplete-"))
    const source = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "source", "db") }),
    )
    const target = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "target", "db") }),
    )
    const key = randomBytes(32)
    const keys = {
      async current() {
        return { version: "one", key }
      },
      async resolve() {
        return key
      },
    }
    try {
      await Storage.provide({ store: source, artifactDirectory: path.join(root, "source", "content") }, async () => {
        await Storage.write(["ordinary", "one"], { retained: true })
        await Storage.write(["private", "one"], { credential: "fixture-sensitive-record" })
        await Storage.writeBinary(["evidence", "one"], Buffer.from("required bytes"))
        await StorageCheckpoint.exportArchive({
          directory: path.join(root, "archive"),
          archiveID: "one",
          namespaceID: "service",
          buildVersion: "fixture",
          keys,
          protect: (entry) => entry.type === "record" && entry.key[0] === "private",
        })
      })
      await Storage.provide({ store: target, artifactDirectory: path.join(root, "target", "content") }, async () => {
        await expect(
          StorageCheckpoint.restoreArchive({
            directory: path.join(root, "archive"),
            keys: {
              ...keys,
              async resolve() {
                return randomBytes(32)
              },
            },
            restoreID: "bad-key",
            finalize: async () => {},
          }),
        ).rejects.toThrow("authentication")
        expect(await Storage.query({ prefix: ["ordinary"], limit: 1 })).toEqual([])
        const files = await fs.readdir(path.join(root, "archive", "objects"))
        await fs.rm(path.join(root, "archive", "objects", files[0]))
        await expect(
          StorageCheckpoint.restoreArchive({
            directory: path.join(root, "archive"),
            keys,
            restoreID: "missing",
            finalize: async () => {},
          }),
        ).rejects.toThrow()
        expect(await Storage.query({ prefix: ["ordinary"], limit: 1 })).toEqual([])
      })
    } finally {
      await source.close()
      await target.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))

test("object-backed checkpoints restore through native object manifests without local content fallback", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-objects-"))
    const source = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "source", "db") }),
    )
    const target = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "target", "db") }),
    )
    const key = randomBytes(32)
    const keys = {
      async current() {
        return { version: "one", key }
      },
      async resolve() {
        return key
      },
    }
    function objects() {
      const values = new Map<string, Uint8Array>()
      return {
        blobs: {
          async put(hash: string, bytes: Uint8Array) {
            values.set(hash, new Uint8Array(bytes))
          },
          async get(hash: string, max: number) {
            const bytes = values.get(hash)
            if (!bytes || bytes.length > max) throw new Error("Missing bounded object")
            return bytes
          },
          async delete(hash: string) {
            values.delete(hash)
          },
        },
        writerID: crypto.randomUUID(),
      }
    }
    const bytes = randomBytes(4 * 1024 * 1024 + 1)
    const sourceHandle = {
      store: source,
      artifactDirectory: path.join(root, "source", "unused-content"),
      artifactObjects: objects(),
    }
    const targetHandle = {
      store: target,
      artifactDirectory: path.join(root, "target", "unused-content"),
      artifactObjects: objects(),
    }
    try {
      await Storage.provide(sourceHandle, async () => {
        using prepared = await Storage.prepareBinaryStream(
          ["one", "binary"],
          (async function* () {
            yield bytes.subarray(0, 1024)
            yield bytes.subarray(1024)
          })(),
        )
        await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
        await StorageCheckpoint.exportArchive({
          directory: path.join(root, "archive"),
          archiveID: "objects",
          namespaceID: "resource",
          buildVersion: "fixture",
          keys,
          protect: () => false,
        })
      })
      let finalizations = 0
      await Storage.provide(targetHandle, async () => {
        const restore = {
          directory: path.join(root, "archive"),
          keys,
          restoreID: "one",
          finalize: async (tx: Parameters<Parameters<typeof StorageCheckpoint.restoreArchive>[0]["finalize"]>[0]) => {
            finalizations++
            await tx.write(["recovery", "paused"], true)
          },
        }
        await StorageCheckpoint.restoreArchive(restore)
        expect(await Storage.readBinary(["one", "binary"])).toEqual(bytes)
        expect(await Storage.validateArtifacts(Storage.current())).toBe(1)
        await StorageCheckpoint.restoreArchive(restore)
        expect(finalizations).toBe(1)
      })
      expect(
        await fs.stat(path.join(sourceHandle.artifactDirectory, "agent-artifacts")).catch(() => undefined),
      ).toBeUndefined()
      expect(
        await fs.stat(path.join(targetHandle.artifactDirectory, "agent-artifacts")).catch(() => undefined),
      ).toBeUndefined()
    } finally {
      await source.close()
      await target.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))

test("export failure removes partial archives and a final fencing failure rolls back canonical restore publication", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-failure-"))
    const source = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "source", "db") }),
    )
    const target = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "target", "db") }),
    )
    const key = randomBytes(32)
    const keys = {
      async current() {
        return { version: "one", key }
      },
      async resolve() {
        return key
      },
    }
    try {
      await Storage.provide({ store: source, artifactDirectory: path.join(root, "source", "content") }, async () => {
        await Storage.write(["private", "one"], { value: "fixture-private-value" })
        await Storage.writeBinary(["evidence", "one"], Buffer.from("complete bytes"))
        const request = {
          directory: path.join(root, "archive"),
          archiveID: "failed",
          namespaceID: "service",
          buildVersion: "fixture",
          keys,
          protect: (entry: Parameters<Parameters<typeof StorageCheckpoint.exportArchive>[0]["protect"]>[0]) =>
            entry.type === "record" && entry.key[0] === "private",
        }
        await expect(
          StorageCheckpoint.exportArchive({
            ...request,
            keys: {
              ...keys,
              async current() {
                throw new Error("Recovery key unavailable")
              },
            },
          }),
        ).rejects.toThrow("key unavailable")
        expect((await fs.readdir(root)).filter((name) => name.startsWith("archive"))).toEqual([])
        await StorageCheckpoint.exportArchive(request)
      })
      await Storage.provide({ store: target, artifactDirectory: path.join(root, "target", "content") }, async () => {
        await expect(
          StorageCheckpoint.restoreArchive({
            directory: path.join(root, "archive"),
            keys,
            restoreID: "rollback",
            finalize: async (tx) => {
              await tx.write(["recovery", "gate"], true)
              throw new Error("Fencing failed")
            },
          }),
        ).rejects.toThrow("Fencing failed")
        expect(await Storage.query({ prefix: ["private"], limit: 1 })).toEqual([])
        expect(await Storage.query({ prefix: ["recovery"], limit: 1 })).toEqual([])
        await expect(Storage.readBinary(["evidence", "one"])).rejects.toMatchObject({ name: "NotFoundError" })
        await StorageCheckpoint.restoreArchive({
          directory: path.join(root, "archive"),
          keys,
          restoreID: "rollback",
          finalize: async (tx) => {
            await tx.write(["recovery", "gate"], true)
          },
        })
        expect(Buffer.from(await Storage.readBinary(["evidence", "one"])).toString()).toBe("complete bytes")
      })
    } finally {
      await source.close()
      await target.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))

for (const kind of ["record", "artifact", "other-restore", "receipt", "event"] as const)
  test(`a competing ${kind} writer during real binary preparation prevents canonical import at its SQL commit boundary`, () =>
    runtime.run(async () => {
      const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-target-race-"))
      const source = await TransactionalStore.open(
        storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "source", "db") }),
      )
      const target = await TransactionalStore.open(
        storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "target", "db") }),
      )
      const key = randomBytes(32)
      const keys = {
        async current() {
          return { version: "one", key }
        },
        async resolve() {
          return key
        },
      }
      try {
        await Storage.provide({ store: source, artifactDirectory: path.join(root, "source", "content") }, async () => {
          await Storage.write(["source", "record"], { source: true })
          await Storage.writeBinary(["source", "binary"], Buffer.from("source bytes"))
          await StorageCheckpoint.exportArchive({
            directory: path.join(root, "archive"),
            archiveID: "one",
            namespaceID: "service",
            buildVersion: "fixture",
            keys,
            protect: () => false,
          })
        })
        await Storage.provide({ store: target, artifactDirectory: path.join(root, "target", "content") }, async () => {
          const prepared = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const original = Storage.prepareBinaryStream
          const fault = spyOn(Storage, "prepareBinaryStream").mockImplementation(async (key, content, options) => {
            const token = await original(key, content, options)
            if (key[0] === "storage_checkpoint_staging") {
              prepared.resolve()
              await release.promise
            }
            return token
          })
          let finalized = false
          const restoring = StorageCheckpoint.restoreArchive({
            directory: path.join(root, "archive"),
            keys,
            restoreID: "race",
            finalize: async () => {
              finalized = true
            },
          })
          void restoring.catch(() => {})
          try {
            await prepared.promise
            const otherKey =
              kind === "other-restore"
                ? ["storage_checkpoint_staging", "different-restore", "foreign"]
                : ["competing", "binary"]
            if (kind === "record") await Storage.write(["competing", "record"], { belongsToOtherWriter: true })
            else if (kind === "receipt")
              await target.transaction(async () => ({ otherWriter: true }), {
                operationID: "foreign-receipt",
                requestHash: "f".repeat(64),
              })
            else if (kind === "event")
              await target.transaction((tx) =>
                tx.enqueue({
                  id: "foreign-event",
                  scopeID: "foreign",
                  type: "foreign-notification",
                  payload: { otherWriter: true },
                }),
              )
            else await Storage.writeBinary(otherKey, Buffer.from("other writer bytes"))
            release.resolve()
            await expect(restoring).rejects.toThrow("empty namespace")
            expect(finalized).toBe(false)
            expect(await Storage.query({ prefix: ["source"], limit: 1 })).toEqual([])
            await expect(Storage.readBinary(["source", "binary"])).rejects.toMatchObject({ name: "NotFoundError" })
            if (kind === "record")
              expect(await Storage.read(["competing", "record"])).toEqual({ belongsToOtherWriter: true })
            else if (kind === "receipt")
              expect(await target.operationReceipt("foreign-receipt")).toMatchObject({
                result: { value: { otherWriter: true } },
              })
            else if (kind === "event")
              expect(
                await target.snapshot(async (tx) => {
                  const values = []
                  for await (const entry of tx.exportEntries()) if (entry.type === "event") values.push(entry)
                  return values
                }),
              ).toMatchObject([{ type: "event", id: "foreign-event", payload: { otherWriter: true } }])
            else expect(Buffer.from(await Storage.readBinary(otherKey)).toString()).toBe("other writer bytes")
          } finally {
            release.resolve()
            await Promise.allSettled([restoring])
            fault.mockRestore()
          }
        })
      } finally {
        await source.close()
        await target.close()
        await fs.rm(root, { recursive: true, force: true })
      }
    }))
