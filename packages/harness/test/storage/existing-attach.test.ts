import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { StorageBootstrap } from "../../src/storage/bootstrap"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "existing-attach-"))
afterAll(() => runtime.run(() => fs.rm(directory, { recursive: true, force: true })))

async function fixture() {
  const root = path.join(directory, crypto.randomUUID(), ".synergy")
  const prepared = await StorageBootstrap.prepare({ root })
  await prepared.store.write(["retained", "record"], { value: "original" })
  await prepared.activate()
  const options = prepared.store.options
  if (options.backend !== "sqlite") throw new Error("Expected the SQLite fixture")
  await prepared.store.close()
  return { root, options }
}

function inspect(filename: string, mutate?: (database: Database) => void) {
  const database = new Database(filename, { strict: true })
  try {
    mutate?.(database)
    return {
      schema: database.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
      namespace: database.query("SELECT * FROM storage_namespaces ORDER BY namespace").all(),
      records: database.query("SELECT * FROM storage_records ORDER BY namespace, key_id").all(),
      preparation: database.query("SELECT * FROM storage_evidence_preparation ORDER BY namespace").all(),
    }
  } finally {
    database.close()
  }
}

test("verified existing attachment rejects missing schema without repairing it", () =>
  runtime.run(async () => {
    for (const statement of [
      "DROP INDEX storage_nodes_parent",
      "DROP TRIGGER storage_evidence_insert",
      "DROP TABLE storage_text_gc",
    ]) {
      const { options } = await fixture()
      const before = inspect(options.filename, (database) => database.exec(statement))
      const opened = TransactionalStore.openExisting(options)
      await expect(
        opened.then(async (store) => {
          await store.close()
        }),
      ).rejects.toMatchObject({ name: "StorageIntegrityError" })
      expect(inspect(options.filename)).toEqual(before)
    }
  }))

test("existing-only attachment cannot create a database, initialize an empty file or become writable from readonly", () =>
  runtime.run(async () => {
    const filename = path.join(directory, crypto.randomUUID(), "empty.sqlite")
    const options = { backend: "sqlite" as const, filename, namespace: "empty" }
    await expect(TransactionalStore.openExisting(options)).rejects.toMatchObject({ name: "StorageIntegrityError" })
    expect(await fs.stat(path.dirname(filename)).catch(() => undefined)).toBeUndefined()
    await fs.mkdir(path.dirname(filename))
    await fs.writeFile(filename, new Uint8Array())
    await expect(TransactionalStore.openExisting(options)).rejects.toMatchObject({ name: "StorageIntegrityError" })
    expect(await fs.readFile(filename)).toEqual(Buffer.alloc(0))
    const selected = await fixture()
    const before = inspect(selected.options.filename)
    await expect(TransactionalStore.openExisting({ ...selected.options, readonly: true })).rejects.toMatchObject({
      name: "StorageIntegrityError",
    })
    expect(inspect(selected.options.filename)).toEqual(before)
  }))

test("existing-only attachment preserves old format and unprepared projections instead of upgrading", () =>
  runtime.run(async () => {
    for (const mutation of [
      "UPDATE storage_namespaces SET version = 2",
      "UPDATE storage_evidence_preparation SET phase = 'rollout'",
    ]) {
      const { options } = await fixture()
      const before = inspect(options.filename, (database) => database.exec(mutation))
      const opened = TransactionalStore.openExisting(options)
      await expect(
        opened.then(async (store) => {
          await store.close()
        }),
      ).rejects.toMatchObject({ name: "StorageIntegrityError" })
      expect(inspect(options.filename)).toEqual(before)
    }
  }))

test("existing-only Bootstrap validates the original manifest and keeps native writer ownership", () =>
  runtime.run(async () => {
    const { root, options } = await fixture()
    const manifest = await fs.readFile(path.join(root, "data/storage/manifest.json"), "utf8")
    const attached = await StorageBootstrap.openExisting(root)
    try {
      expect(await attached.store.read(["retained", "record"])).toEqual({ value: "original" })
      await attached.store.write(["retained", "cleanup"], { completed: true })
      await expect(StorageBootstrap.openExisting(root)).rejects.toMatchObject({ name: "StorageOwnershipError" })
    } finally {
      await attached.store.close()
    }
    expect(await fs.readFile(path.join(root, "data/storage/manifest.json"), "utf8")).toBe(manifest)
    const before = inspect(options.filename)
    await expect(StorageBootstrap.openExisting(path.join(directory, "missing"))).rejects.toMatchObject({
      name: "StorageIntegrityError",
    })
    expect(await fs.stat(path.join(directory, "missing")).catch(() => undefined)).toBeUndefined()
    await fs.writeFile(
      path.join(root, "data/storage/manifest.json"),
      manifest.replace(/"storeID":"[^"]+"/, `"storeID":"${crypto.randomUUID()}"`),
    )
    await expect(StorageBootstrap.openExisting(root)).rejects.toMatchObject({ name: "StorageIntegrityError" })
    expect(inspect(options.filename)).toEqual(before)
  }))
