import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { Storage } from "../../src/storage/storage"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { StoragePortable } from "../../src/storage/portable"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())
const Evidence = z.strictObject({ operationID: z.string(), requestHash: z.string(), result: z.string() })

for (const kind of ["same-prefix", "wrong-hash", "wrong-result"] as const)
  test(`a ${kind} receipt cannot impersonate this restore's actual object preparation`, () =>
    runtime.run(async () => {
      const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-receipts-"))
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
      const values = new Map<string, Uint8Array>()
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
        await Storage.provide(
          {
            store: target,
            artifactDirectory: path.join(root, "unused"),
            artifactObjects: {
              writerID: "one",
              blobs: {
                async put(hash, bytes) {
                  values.set(hash, new Uint8Array(bytes))
                },
                async get(hash, max) {
                  const bytes = values.get(hash)
                  if (!bytes || bytes.length > max) throw new Error("Missing bounded object")
                  return bytes
                },
                async delete(hash) {
                  values.delete(hash)
                },
              },
            },
          },
          async () => {
            const original = StoragePortable.importFile
            const fault = spyOn(StoragePortable, "importFile").mockImplementation(async (store, filename, options) => {
              const rows = await Storage.query({
                prefix: ["storage_checkpoint_staging", "restore", "preparation-receipts"],
                limit: 2,
              })
              expect(rows).toHaveLength(1)
              const row = rows[0]!
              const evidence = Evidence.parse(row.value)
              expect(await target.operationReceipt(evidence.operationID)).toEqual({
                requestHash: evidence.requestHash,
                result: { value: true },
              })
              if (kind === "same-prefix")
                await target.transaction(async () => true, {
                  operationID: `artifact-stream-prepare:${crypto.randomUUID()}`,
                  requestHash: evidence.requestHash,
                })
              else
                await Storage.write(row.key, {
                  ...evidence,
                  ...(kind === "wrong-hash"
                    ? { requestHash: `${evidence.requestHash[0] === "a" ? "b" : "a"}${evidence.requestHash.slice(1)}` }
                    : { result: JSON.stringify({ value: false }) }),
                })
              return original(store, filename, options)
            })
            let finalized = false
            try {
              await expect(
                StorageCheckpoint.restoreArchive({
                  directory: path.join(root, "archive"),
                  keys,
                  restoreID: "restore",
                  finalize: async () => {
                    finalized = true
                  },
                }),
              ).rejects.toThrow("empty namespace")
              expect(finalized).toBe(false)
              expect(await Storage.query({ prefix: ["source"], limit: 1 })).toEqual([])
              await expect(Storage.readBinary(["source", "binary"])).rejects.toMatchObject({ name: "NotFoundError" })
            } finally {
              fault.mockRestore()
            }
          },
        )
      } finally {
        await source.close()
        await target.close()
        await fs.rm(root, { recursive: true, force: true })
      }
    }))
