import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())

test("prepared binary streams publish atomically and retain their original artifact through a concurrent delete", () =>
  runtime.run(async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-stream-"))
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") }),
    )
    try {
      await Storage.provide({ store, artifactDirectory: path.join(root, "content") }, async () => {
        using prepared = await Storage.prepareBinaryStream(
          ["evidence", "stream"],
          (async function* () {
            yield Buffer.from("first")
            yield Buffer.from("second")
          })(),
        )
        await expect(Storage.readBinary(["evidence", "stream"])).rejects.toMatchObject({ name: "NotFoundError" })
        await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
        expect(Buffer.from(await Storage.readBinary(["evidence", "stream"])).toString()).toBe("firstsecond")
        const stream = Storage.readBinaryStream(["evidence", "stream"])
        const first = await stream.next()
        expect(first.done).toBe(false)
        await Storage.removeTree(["evidence"])
        expect(await Storage.collectArtifactGarbage()).toBe(0)
        expect(Buffer.from(first.value!).toString()).toBe("firstsecond")
        expect((await stream.next()).done).toBe(true)
        expect(await Storage.collectArtifactGarbage()).toBe(1)
        for (let index = 0; index < 17; index++)
          await Storage.writeBinary(["selected", String(index).padStart(2, "0")], new Uint8Array([index]))
        await Storage.writeBinary(["unrelated", "file"], new Uint8Array([255]))
        const keys: string[][] = []
        let after: string[] | undefined
        for (;;) {
          const page = await Storage.artifactReferences({ prefix: ["selected"], after, limit: 5 })
          keys.push(...page.map((entry) => entry.key))
          if (page.length < 5) break
          after = page.at(-1)!.key
        }
        expect(keys).toHaveLength(17)
        expect(keys.every((key) => key[0] === "selected")).toBe(true)
        await Storage.transaction(() => Storage.publishBinaryReference(keys[0], ["restored", "file"]))
        expect(await Storage.readBinary(["restored", "file"])).toEqual(new Uint8Array([0]))
      })
    } finally {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }))
