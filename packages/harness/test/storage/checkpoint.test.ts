import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { StoragePortable } from "../../src/storage/portable"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

test("a native checkpoint keeps exact snapshot bytes pinned after live references change", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-"))
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
    )
    try {
      await Storage.provide({ store, artifactDirectory: path.join(root, "content") }, async () => {
        const bytes = Buffer.from("exact immutable checkpoint bytes")
        await Storage.writeBinary(["evidence", "one"], bytes)
        await Storage.write(["owner", "revision"], { revision: 1 })
        let opened: AsyncIterable<Uint8Array> | undefined
        await Storage.withArtifactCheckpoint(async (checkpoint) => {
          const file = path.join(root, "records.ndjson")
          await checkpoint.exportPortable(file)
          await Storage.removeTree(["evidence"])
          await Storage.write(["owner", "revision"], { revision: 2 })
          let artifacts = 0
          for await (const entry of StoragePortable.entries(file)) {
            if (entry.type === "record" && entry.key[0] === "owner") expect(entry.value).toEqual({ revision: 1 })
            if (entry.type !== "artifact") continue
            artifacts++
            const chunks = []
            for await (const chunk of checkpoint.stream(entry.location)) chunks.push(chunk)
            expect(Buffer.concat(chunks)).toEqual(bytes)
            opened = checkpoint.stream(entry.location)
          }
          expect(artifacts).toBe(1)
        })
        if (!opened) throw new Error("Expected a checkpoint stream")
        await expect(
          (async () => {
            for await (const _chunk of opened) {
            }
          })(),
        ).rejects.toThrow("checkpoint")
        expect(await Storage.collectArtifactGarbage()).toBe(1)
        const text = await fs.readFile(path.join(root, "records.ndjson"), "utf8")
        await fs.writeFile(path.join(root, "broken.ndjson"), text.replace('"revision":1', '"revision":9'))
        await expect(
          (async () => {
            for await (const _entry of StoragePortable.entries(path.join(root, "broken.ndjson"))) {
            }
          })(),
        ).rejects.toThrow("checksum")
        await fs.writeFile(
          path.join(root, "truncated.ndjson"),
          text.slice(0, text.lastIndexOf("\n", text.length - 2) + 1),
        )
        await expect(
          (async () => {
            for await (const _entry of StoragePortable.entries(path.join(root, "truncated.ndjson"))) {
            }
          })(),
        ).rejects.toThrow("truncated")
      })
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))

test("a checkpoint cannot report completion while an escaped reader still owns its file", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "checkpoint-reader-"))
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
    )
    try {
      await Storage.provide({ store, artifactDirectory: path.join(root, "content") }, async () => {
        await Storage.writeBinary(["evidence", "one"], Buffer.alloc(256 * 1024, 71))
        await expect(
          Storage.withArtifactCheckpoint(async (checkpoint) => {
            const reference = (await Storage.artifactReferences({ prefix: ["evidence"], limit: 1 }))[0]!
            const reader = checkpoint.stream(reference.location)
            expect((await reader.next()).done).toBe(false)
          }),
        ).rejects.toThrow("unfinished")
        await Storage.removeTree(["evidence"])
        expect(await Storage.collectArtifactGarbage()).toBe(1)
      })
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))
