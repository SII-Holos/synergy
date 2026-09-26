import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StoragePortable } from "../../src/storage/portable"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "portable-"))
  const source = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "source",
    filename: path.join(root, "source.sqlite"),
  })
  const target = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "target",
    filename: path.join(root, "target.sqlite"),
  })
  return {
    root,
    source,
    target,
    async [Symbol.asyncDispose]() {
      await source.close()
      await target.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("portable data preserves revisions, unknown fields, and committed command receipts", async () => {
  await using data = await fixture()
  await data.source.transaction(
    async (tx) => {
      await tx.write(["record"], { future: { field: 3 } })
      return { accepted: true }
    },
    { operationID: "command", requestHash: "same-input" },
  )
  const filename = path.join(data.root, "records.ndjson")
  await StoragePortable.exportFile(data.source, filename)
  const progress: Array<{ stage: string; current: number; bytes: number }> = []
  await StoragePortable.importFile(data.target, filename, { progress: (value) => progress.push(value) })
  expect(progress.map((value) => value.stage)).toContain("archive-verify")
  expect(progress.map((value) => value.stage)).toContain("archive-import")
  expect(progress.filter((value) => value.stage === "archive-verify").at(-1)?.bytes).toBe(
    (await fs.stat(filename)).size,
  )
  expect(progress.filter((value) => value.stage === "archive-import").at(-1)?.current).toBeGreaterThan(0)
  expect(await data.target.versioned(["record"])).toEqual(await data.source.versioned(["record"]))
  expect(
    await data.target.transaction<{ accepted: boolean }>(
      async () => {
        throw new Error("must not replay")
      },
      { operationID: "command", requestHash: "same-input" },
    ),
  ).toEqual({ accepted: true })
})

test("a damaged portable archive never exposes a partial imported aggregate", async () => {
  await using data = await fixture()
  await data.source.write(["sessions", "scope", "one", "info"], { id: "one" })
  const filename = path.join(data.root, "records.ndjson")
  await StoragePortable.exportFile(data.source, filename)
  const text = await Bun.file(filename).text()
  await Bun.write(filename, text.replace('"id":"one"', '"id":"two"'))
  await expect(StoragePortable.importFile(data.target, filename)).rejects.toThrow("checksum")
  expect(await data.target.list([])).toEqual([])
})

test("owner transforms keep archive integrity and roll back with their derived indexes", async () => {
  await using data = await fixture()
  await data.source.write(["source"], { value: "historical", future: 42 })
  const filename = path.join(data.root, "records.ndjson")
  await StoragePortable.exportFile(data.source, filename)
  const original = await Bun.file(filename).text()
  const options = {
    transform: (entry: import("../../src/storage/portable").StorageEntry) =>
      entry.type === "record"
        ? { ...entry, key: ["target"], value: { ...(entry.value as Record<string, unknown>), value: "detached" } }
        : entry,
    afterImport: async (tx: import("../../src/storage/transactional-store").StoreTransaction) => {
      await tx.write(["index"], "target")
    },
  }
  await expect(
    StoragePortable.importFile(data.target, filename, {
      ...options,
      afterImport: async (tx) => {
        await options.afterImport(tx)
        throw new Error("owner publication failed")
      },
    }),
  ).rejects.toThrow("owner publication failed")
  expect(await data.target.list([])).toEqual([])
  await StoragePortable.importFile(data.target, filename, options)
  expect(await data.target.read<{ value: string; future: number }>(["target"])).toEqual({
    value: "detached",
    future: 42,
  })
  expect(await Bun.file(filename).text()).toBe(original)
  await data.target.write(["target"], { value: "keep local" })
  await StoragePortable.importFile(data.target, filename, {
    ...options,
    accept: async (entry, tx) => entry.type !== "record" || (await tx.readMany([entry.key]))[0] === undefined,
  })
  expect(await data.target.read<{ value: string }>(["target"])).toEqual({ value: "keep local" })
})
