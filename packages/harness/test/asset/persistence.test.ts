import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Asset } from "../../src/asset/asset"
import { storedAssets } from "../../src/asset/stored-assets"
import { materializeAttachmentInput } from "../../src/attachment/model-input"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

test("assets survive loss of their local cache and model attachments read the authoritative bytes", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "stored-assets-"))
  const options = storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") })
  const objects = new Map<string, Uint8Array>()
  const blobs = {
    async put(id: string, bytes: Uint8Array) {
      objects.set(id, bytes)
    },
    async get(id: string) {
      const b = objects.get(id)
      if (!b) throw new Error("unavailable")
      return b
    },
    async delete(id: string) {
      objects.delete(id)
    },
  }
  let store = await TransactionalStore.open(options)
  let runtime = await storageTestRuntime()
  const install = () => runtime.run(() => Asset.registerStorage(storedAssets()))
  install()
  const run = <T>(body: () => Promise<T>) =>
    runtime.run(() =>
      Storage.provide(
        { store, artifactDirectory: path.join(root, "unused"), artifactObjects: { writerID: "writer", blobs } },
        body,
      ),
    )
  try {
    const id = await run(() => Asset.write(Buffer.from("image bytes"), "image/png"))
    await runtime.close()
    await store.close()
    runtime = await storageTestRuntime()
    store = await TransactionalStore.open(options)
    install()
    await run(async () => {
      expect(await fs.exists(Asset.filePath(id))).toBe(false)
      const output = await materializeAttachmentInput(
        [{ role: "user", content: [{ type: "image", image: `asset://${id}`, mediaType: "image/png" }] }],
        new AbortController().signal,
      )
      expect(JSON.stringify(output)).toContain(Buffer.from("image bytes").toString("base64"))
      expect(await fs.exists(Asset.filePath(id))).toBe(true)
      objects.clear()
      await expect(Asset.read(id)).rejects.toThrow("unavailable")
      expect(await Asset.read("../outside")).toBeUndefined()
    })
  } finally {
    await runtime.close()
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
