import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StoredToolOutput } from "../../src/tool/stored-output"
import { Truncate } from "../../src/tool/truncation"
import { ReadToolOutputTool } from "../../src/tool/read-output"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

test("full outputs and exact aliases survive a new runtime without any original files", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "stored-output-"))
  const options = storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") })
  const objects = new Map<string, Uint8Array>()
  let writes = true
  const blobs = {
    async put(id: string, bytes: Uint8Array) {
      if (!writes) throw new Error("object_store_unavailable")
      objects.set(id, new Uint8Array(bytes))
    },
    async get(id: string) {
      const bytes = objects.get(id)
      if (!bytes) throw new Error("object_missing")
      return bytes
    },
    async delete(id: string) {
      objects.delete(id)
    },
  }
  let store = await TransactionalStore.open(options)
  let runtime = await storageTestRuntime()
  const install = () => runtime.run(() => Truncate.registerStorage(StoredToolOutput.persistence()))
  install()
  const run = <T>(fn: () => Promise<T>) =>
    runtime.run(() =>
      Storage.provide(
        {
          store,
          artifactDirectory: path.join(root, "unused"),
          artifactObjects: { writerID: "writer", blobs },
        },
        fn,
      ),
    )
  const text = "你好😀\n".repeat(400)
  let saved = ""
  const alias = "/former-host/.synergy/data/tool-output/tool_imported"
  try {
    await run(async () => {
      const result = await Truncate.output(text, { maxBytes: 10 })
      if (!result.truncated) throw new Error("fixture must truncate")
      saved = result.outputPath
      expect(result.content).toContain("read_tool_output")
      await StoredToolOutput.save("tool_imported", "retained history", [alias])
      await StoredToolOutput.save("tool_imported", "retained history", [alias])
      await expect(StoredToolOutput.save("tool_other", "different", [alias])).rejects.toThrow("alias collision")
      await expect(StoredToolOutput.save("tool_imported", "different")).rejects.toThrow("identifier collision")
      writes = false
      await expect(Truncate.output("unpublished".repeat(300), { maxBytes: 10 })).rejects.toThrow(
        "object_store_unavailable",
      )
      writes = true
    })
    await runtime.close()
    await store.close()
    runtime = await storageTestRuntime()
    store = await TransactionalStore.open(options)
    install()
    await run(async () => {
      let offset = 0
      let restored = ""
      do {
        const page = await StoredToolOutput.read({ reference: saved, offset, limit: 11 })
        restored += page.text
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      } while (offset < Buffer.byteLength(text))
      expect(restored).toBe(text)
      expect((await StoredToolOutput.read({ reference: alias })).text).toBe("retained history")
      await expect(StoredToolOutput.read({ reference: alias.replace("former-host", "another-host") })).rejects.toThrow()
      await expect(StoredToolOutput.read({ reference: "tool-output://../outside" })).rejects.toThrow()
      await expect(StoredToolOutput.read({ reference: saved, offset: 1 })).rejects.toThrow("utf8_boundary")
      const tool = await ReadToolOutputTool.init()
      expect(ReadToolOutputTool.requiresWorkspace).toBe(false)
      const result = await tool.execute(
        { reference: saved, limit: 8 * 1024 },
        {
          sessionID: "ses_fixture",
          messageID: "msg_fixture",
          agent: "fixture",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {
            throw new Error("unexpected filesystem permission")
          },
        },
      )
      expect(JSON.parse(result.output).text).toBe(text)
      const controller = new AbortController()
      controller.abort()
      await expect(
        tool.execute(
          { reference: saved, limit: 8 * 1024 },
          {
            sessionID: "ses_fixture",
            messageID: "msg_fixture",
            agent: "fixture",
            abort: controller.signal,
            metadata() {},
            async ask() {},
          },
        ),
      ).rejects.toThrow()
      objects.clear()
      await expect(StoredToolOutput.read({ reference: saved })).rejects.toThrow("object_missing")
    })
  } finally {
    await runtime.close()
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
