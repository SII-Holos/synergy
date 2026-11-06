import { expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import fs from "node:fs/promises"
import path from "node:path"
import { Asset } from "../../src/asset/asset"
import { storedAssets } from "../../src/asset/stored-assets"
import { materializeAttachmentInput } from "../../src/attachment/model-input"
import { AttachmentImageInput } from "../../src/attachment/image-input"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

test("assets survive loss of their local cache and model attachments read the authoritative bytes", async () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=",
    "base64",
  )
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
  const install = () =>
    runtime.run(() => {
      Asset.registerStorage(storedAssets())
      AttachmentImageInput.register(async (input, signal) => {
        signal.throwIfAborted()
        expect(input).toEqual(new Uint8Array(bytes))
        return {
          ok: true,
          data: Buffer.from(input).toString("base64"),
          mediaType: "image/png",
          width: 1,
          height: 1,
          originalWidth: 1,
          originalHeight: 1,
        }
      })
    })
  install()
  const run = <T>(body: () => Promise<T>) =>
    runtime.run(() =>
      Storage.provide(
        { store, artifactDirectory: path.join(root, "unused"), artifactObjects: { writerID: "writer", blobs } },
        body,
      ),
    )
  try {
    const id = await run(() => Asset.write(bytes, "image/png"))
    await runtime.close()
    await store.close()
    runtime = await storageTestRuntime()
    store = await TransactionalStore.open(options)
    install()
    await run(async () => {
      expect(await fs.exists(Asset.filePath(id))).toBe(false)
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "image", image: `asset://${id}`, mediaType: "image/png" }] },
      ]
      const output = await materializeAttachmentInput(messages, new AbortController().signal)
      expect(output).toEqual([
        {
          role: "user",
          content: [
            { type: "image", image: `data:image/png;base64,${bytes.toString("base64")}`, mediaType: "image/png" },
          ],
        },
      ])
      expect(await fs.exists(Asset.filePath(id))).toBe(true)
      expect(await (await Asset.read(id))!.bytes()).toEqual(new Uint8Array(bytes))
      objects.clear()
      await expect(Asset.read(id)).rejects.toThrow("unavailable")
      await expect(materializeAttachmentInput(messages, new AbortController().signal)).rejects.toThrow("unavailable")
      expect(await Asset.read("../outside")).toBeUndefined()
    })
  } finally {
    await runtime.close()
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
