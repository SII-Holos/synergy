import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import {
  TransactionalStore,
  type StoreTransaction,
  type TransactionOptions,
} from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-retention-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
  )
  const handle = { store, artifactDirectory: path.join(root, "content") }
  return {
    store,
    handle,
    run<T>(body: () => Promise<T>) {
      return runtime.run(() => Storage.provide(handle, body))
    },
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("checkpoint retention requires the actual checkpoint, original Store and real write transaction", async () => {
  await using f = await fixture()
  await using foreign = await fixture()
  await f.run(async () => {
    const key = ["checkpoint-retention", "bytes"]
    const bytes = Buffer.from("retained through the actual transaction")
    await Storage.writeBinary(key, bytes)
    await Storage.withArtifactCheckpoint(async (checkpoint) => {
      await expect(Storage.snapshot(() => Storage.retainCheckpointArtifact(checkpoint, key))).rejects.toThrow(
        "write transaction",
      )
      await expect(Storage.transaction(() => Storage.retainCheckpointArtifact({ ...checkpoint }, key))).rejects.toThrow(
        "checkpoint",
      )
      await expect(
        Storage.provide(foreign.handle, () =>
          Storage.transaction(() => Storage.retainCheckpointArtifact(checkpoint, key)),
        ),
      ).rejects.toThrow("checkpoint")
      await Storage.transaction(async (tx) => {
        const location = await Storage.retainCheckpointArtifact(checkpoint, key)
        await tx.removeTree(key)
        const chunks: Uint8Array[] = []
        for await (const chunk of checkpoint.stream(location)) chunks.push(chunk)
        expect(Buffer.concat(chunks)).toEqual(bytes)
      })
    })
    expect(await Storage.collectArtifactGarbage()).toBe(1)
  })
})

test("checkpoint retention keeps the last native pin after an unknown actual commit", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const key = ["checkpoint-retention", "unknown"]
    await Storage.writeBinary(key, Buffer.from("unknown commit must retain its original native pack"))
    const transaction = f.store.transaction.bind(f.store)
    const lost = new StorageCommitUnknownError("checkpoint-retain-unknown", new Error("Original acknowledgement lost"))
    using fault = spyOn(f.store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        const result = await transaction(body, options)
        if (options?.operationID === "checkpoint-retain-unknown") throw lost
        return result
      },
    )
    await Storage.withArtifactCheckpoint(async (checkpoint) => {
      await expect(
        Storage.transaction(
          async (tx) => {
            await Storage.retainCheckpointArtifact(checkpoint, key)
            await tx.removeTree(key)
          },
          { operationID: "checkpoint-retain-unknown", requestHash: "a".repeat(64) },
        ),
      ).rejects.toBe(lost)
    })
    fault.mockRestore()
    await expect(Storage.readBinary(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
  })
})

test("a transaction escaping its checkpoint cannot commit after that native frame closes", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const key = ["checkpoint-retention", "late"]
    const bytes = Buffer.from("the original reference survives the escaped transaction")
    await Storage.writeBinary(key, bytes)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let pending: Promise<void> | undefined
    try {
      await Storage.withArtifactCheckpoint(async (checkpoint) => {
        pending = Storage.transaction(async (tx) => {
          await Storage.retainCheckpointArtifact(checkpoint, key)
          await tx.removeTree(key)
          entered.resolve()
          await resume.promise
        })
        void pending.catch(() => {})
        await entered.promise
      })
      resume.resolve()
      await expect(pending).rejects.toThrow("checkpoint")
      expect(Buffer.from(await Storage.readBinary(key))).toEqual(bytes)
    } finally {
      resume.resolve()
      await pending?.catch(() => {})
    }
  })
})
