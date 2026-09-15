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
