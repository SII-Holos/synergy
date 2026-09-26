import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { StorageCompat } from "../../src/storage/compat"

test("migration can prepare binary evidence while business reads and writes stay fenced", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: crypto.randomUUID(),
      filename: path.join(tmp.path, "db"),
    })
    const owner = { sessionID: "old", scopeID: "scope" }
    const key = ["sessions", owner.scopeID, owner.sessionID, "rollout", "blobs", "output"]
    const content = new TextEncoder().encode("retained historical output")
    try {
      await StorageCompat.writeLocator(store, { ...owner, status: "partial" })
      await Storage.provide({ store, artifactDirectory: tmp.path }, async () => {
        await expect(Storage.writeBinary(key, content)).rejects.toThrow("preparation")
        await Storage.withMigrationRecords(async () => {
          await Storage.writeBinary(key, content)
          await Storage.writeBinary(key, content)
          expect(await Storage.readBinary(key)).toEqual(content)
        })
        await expect(Storage.readBinary(key)).rejects.toThrow("preparation")
        await expect(Storage.writeBinary(key, content)).rejects.toThrow("preparation")
        await StorageCompat.writeLocator(store, { ...owner, status: "imported" })
        expect(await Storage.readBinary(key)).toEqual(content)
        expect((await store.verify()).issues).toEqual([])
      })
    } finally {
      await store.close()
    }
  }))

test("unpublished owner records remain invisible and immutable until atomic publication", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: crypto.randomUUID(),
      filename: path.join(tmp.path, "db"),
    })
    const key = ["sessions", "scope", "old", "messages", "a", "info"]
    const live = ["sessions", "scope", "new", "messages", "b", "info"]
    try {
      await store.write(key, { text: "partial" })
      await store.write(live, { text: "live" })
      await StorageCompat.writeLocator(store, { sessionID: "old", scopeID: "scope", status: "partial" })
      await Storage.provide({ store, artifactDirectory: tmp.path }, async () => {
        await expect(Storage.read(key)).rejects.toThrow("preparation")
        await expect(Storage.readMany([live, key])).rejects.toThrow("preparation")
        await expect(Storage.transaction((tx) => tx.removeMany([live, key]))).rejects.toThrow("preparation")
        expect(await Storage.read<{ text: string }>(live)).toEqual({ text: "live" })
        await expect(Storage.write(key, {})).rejects.toThrow("preparation")
        await expect(Storage.transaction((tx) => tx.removeTree(["sessions", "scope"]))).rejects.toThrow("preparation")
        await expect(
          Storage.snapshot(async (tx) => {
            for await (const artifact of tx.artifacts()) void artifact
          }),
        ).rejects.toThrow("preparation")
        await expect(
          Storage.snapshot(async (tx) => {
            for await (const entry of tx.exportEntries()) void entry
          }),
        ).rejects.toThrow("preparation")
        expect((await Storage.query({ kind: "message", limit: 1 })).map((row) => row.key)).toEqual([live])
        expect(await Storage.scan(["sessions", "scope"])).toEqual(["new"])
        expect(await Storage.list(["sessions"])).toEqual([live])
        expect(await store.read<{ text: string }>(key)).toEqual({ text: "partial" })
        await store.transaction(async (tx) => {
          await tx.write(key, { text: "complete" })
          await StorageCompat.setLocator(tx, { sessionID: "old", scopeID: "scope", status: "imported" })
        })
        expect(await Storage.read<{ text: string }>(key)).toEqual({ text: "complete" })
        expect(await Storage.scan(["sessions", "scope"])).toEqual(["new", "old"])
      })
    } finally {
      await store.close()
    }
  }))

afterRuntimeTests(() => runtime.close())
