import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PackedLegacyImporter } from "../../src/storage/packed-import"
import { StorageCompat } from "../../src/storage/compat"
import { TransactionalStore } from "../../src/storage/transactional-store"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "compat-defer-"))
  const dataRoot = path.join(root, "data")
  const backupRoot = path.join(root, "backup")
  await fs.mkdir(dataRoot)
  const namespace = crypto.randomUUID()
  const store = await TransactionalStore.open(
    process.env.SYNERGY_TEST_POSTGRES_URL
      ? { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL }
      : { backend: "sqlite", namespace, filename: path.join(root, "target.sqlite") },
  )
  async function write(relative: string, value: unknown) {
    const filename = path.join(dataRoot, relative)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, typeof value === "string" ? value : JSON.stringify(value))
  }
  return {
    dataRoot,
    backupRoot,
    store,
    write,
    root,
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function sessionShape(sessionID: string) {
  return {
    id: sessionID,
    scope: { id: "scope", type: "project" },
    title: "compat fixture",
    version: "3.0.22",
    time: { created: 1, updated: 2 },
    controlProfile: "guarded",
    completionNotice: { unread: false, silent: false, unreadCount: 0 },
  }
}

test("deferSessions leaves the session tree on disk while everything else keeps the #1393 invariant", async () => {
  await using f = await fixture()
  await f.write("sessions/scope/aggregate/info.json", sessionShape("aggregate"))
  await f.write("sessions/scope/aggregate/rollout/blobs/prt.bin", "original rollout bytes")
  await f.write("notes/kept.json", { text: "durable".repeat(64) })

  expect(await StorageCompat.seedLocators(f.store, f.dataRoot)).toBe(1)
  const [locator] = await StorageCompat.pendingLocators(f.store)
  expect(locator).toMatchObject({ sessionID: "aggregate", scopeID: "scope", status: "pending" })

  const importer = new PackedLegacyImporter({ ...f, deferSessions: true })
  const result = await importer.run()
  expect(result).toMatchObject({ files: 3, imported: 1, quarantined: 0, retained: 0, artifacts: 0, deferred: 2 })
  expect(await f.store.read(["notes", "kept"])).toMatchObject({ text: "durable".repeat(64) })
  expect(await Bun.file(path.join(f.dataRoot, "sessions/scope/aggregate/info.json")).exists()).toBe(true)
  expect(await Bun.file(path.join(f.dataRoot, "sessions/scope/aggregate/rollout/blobs/prt.bin")).exists()).toBe(true)

  await importer.retire()
  expect(await Bun.file(path.join(f.dataRoot, "notes/kept.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(f.dataRoot, "sessions/scope/aggregate/info.json")).exists()).toBe(true)
  expect(await Bun.file(path.join(f.dataRoot, "sessions/scope/aggregate/rollout/blobs/prt.bin")).exists()).toBe(true)

  await StorageCompat.rejectForeignWriters(f.dataRoot, f.store)

  await fs.mkdir(path.join(f.dataRoot, "notes"), { recursive: true })
  await fs.writeFile(path.join(f.dataRoot, "notes/rogue.json"), JSON.stringify({ text: "rogue" }))
  await expect(StorageCompat.rejectForeignWriters(f.dataRoot, f.store)).rejects.toThrow("Legacy JSON records appeared")
  await fs.rm(path.join(f.dataRoot, "notes/rogue.json"))
  await StorageCompat.rejectForeignWriters(f.dataRoot, f.store)
})

test("the compat tripwire turns imported-session JSON into a fatal foreign writer", async () => {
  await using f = await fixture()
  await f.write("sessions/scope/aggregate/info.json", sessionShape("aggregate"))
  await f.write("notes/kept.json", { text: "durable" })
  await StorageCompat.seedLocators(f.store, f.dataRoot)
  const importer = new PackedLegacyImporter({ ...f, deferSessions: true })
  await importer.run()
  await importer.retire()

  await StorageCompat.rejectForeignWriters(f.dataRoot, f.store)

  await f.store.write(StorageCompat.locatorKey("aggregate"), {
    sessionID: "aggregate",
    scopeID: "scope",
    status: "imported",
  })
  await expect(StorageCompat.rejectForeignWriters(f.dataRoot, f.store)).rejects.toThrow("legacy writer is still active")

  await f.store.write(StorageCompat.locatorKey("ghost"), {
    sessionID: "ghost",
    scopeID: "scope",
    status: "quarantined",
    source: "sessions/scope/aggregate/info.json",
  })
  await expect(StorageCompat.rejectForeignWriters(f.dataRoot, f.store)).rejects.toThrow("legacy writer is still active")
})

test("deferral is stable across an interrupted resume", async () => {
  await using f = await fixture()
  await f.write("sessions/scope/aggregate/info.json", sessionShape("aggregate"))
  for (let n = 0; n < 300; n++) await f.write(`notes/${n}.json`, { n, text: "durable".repeat(200) })
  await StorageCompat.seedLocators(f.store, f.dataRoot)

  let interrupted = false
  await expect(
    new PackedLegacyImporter({
      ...f,
      deferSessions: true,
      progress: (value) => {
        if (value.stage === "import" && value.current >= 64 && !interrupted) {
          interrupted = true
          throw new Error("interrupted after commit")
        }
      },
    }).run(),
  ).rejects.toThrow("interrupted")

  const result = await new PackedLegacyImporter({ ...f, deferSessions: true }).run()
  expect(result.deferred).toBe(1)
  expect(await Bun.file(path.join(f.dataRoot, "sessions/scope/aggregate/info.json")).exists()).toBe(true)
  const [locator] = await StorageCompat.pendingLocators(f.store)
  expect(locator?.status).toBe("pending")
})
