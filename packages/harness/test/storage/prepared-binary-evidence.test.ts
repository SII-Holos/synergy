import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

test("prepared binary receipt evidence belongs to its opaque live token and local packs have none", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "prepared-evidence-"))
    const one = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "one") }),
    )
    const two = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "two") }),
    )
    try {
      await Storage.provide({ store: one, artifactDirectory: path.join(root, "content-one") }, async () => {
        const prepared = await Storage.prepareBinaryStream(
          ["evidence", "one"],
          (async function* () {
            yield Buffer.from("bytes")
          })(),
        )
        try {
          expect(await Storage.preparedBinaryReceipt(prepared)).toBeUndefined()
          await expect(Storage.preparedBinaryReceipt({} as Storage.PreparedBinary)).rejects.toThrow("prepared")
          await Storage.provide({ store: two, artifactDirectory: path.join(root, "content-two") }, async () => {
            await expect(Storage.preparedBinaryReceipt(prepared)).rejects.toThrow("owner")
          })
          const other = await storageTestRuntime()
          try {
            await other.run(() =>
              Storage.provide({ store: one, artifactDirectory: path.join(root, "content-one") }, async () => {
                await expect(Storage.preparedBinaryReceipt(prepared)).rejects.toThrow("owner")
              }),
            )
          } finally {
            await other.close()
          }
        } finally {
          prepared[Symbol.dispose]()
        }
        await expect(Storage.preparedBinaryReceipt(prepared)).rejects.toThrow("prepared")
      })
    } finally {
      await one.close()
      await two.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))

test("object preparation evidence matches its committed native success receipt and returns immutable metadata", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "object-prepared-evidence-"))
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
    )
    const objects = new Map<string, Uint8Array>()
    try {
      await Storage.provide(
        {
          store,
          artifactDirectory: path.join(root, "unused"),
          artifactObjects: {
            writerID: "one",
            blobs: {
              async put(hash, bytes) {
                objects.set(hash, new Uint8Array(bytes))
              },
              async get(hash, max) {
                const bytes = objects.get(hash)
                if (!bytes || bytes.length > max) throw new Error("Missing bounded object")
                return bytes
              },
              async delete(hash) {
                objects.delete(hash)
              },
            },
          },
        },
        async () => {
          using prepared = await Storage.prepareBinaryStream(
            ["evidence", "one"],
            (async function* () {
              yield Buffer.from("bytes")
            })(),
          )
          const receipt = await Storage.preparedBinaryReceipt(prepared)
          if (!receipt) throw new Error("Expected object preparation receipt evidence")
          expect(await store.operationReceipt(receipt.operationID)).toEqual({
            requestHash: receipt.requestHash,
            result: { value: true },
          })
          expect(receipt.result).toBe(JSON.stringify({ value: true }))
          expect(() => Object.assign(receipt, { requestHash: "f".repeat(64) })).toThrow()
          expect(await Storage.preparedBinaryReceipt(prepared)).toEqual(receipt)
        },
      )
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))
