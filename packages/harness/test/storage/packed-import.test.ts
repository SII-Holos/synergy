import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PackedLegacyImporter } from "../../src/storage/packed-import"
import { PackedBackup } from "../../src/storage/packed-backup"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "packed-import-"))
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

test("packed import checkpoints records and binary references, then retires only backed-up authority", async () => {
  await using f = await fixture()
  await f.write("sessions/scope/session/info.json", {
    id: "session",
    title: "old",
    scope: { id: "scope" },
    time: { created: 1, updated: 2 },
    unknown: { preserved: true },
  })
  for (let n = 0; n < 1400; n++) await f.write(`notes/${n}.json`, { n, text: "durable".repeat(200) })
  await f.write("sessions/scope/session/rollout/blobs/content.bin", "original bytes")
  await f.write("assets/keep", "retained bytes")
  let interrupted = false
  await expect(
    new PackedLegacyImporter({
      ...f,
      progress: (value) => {
        if (value.stage === "import" && value.current >= 256 && !interrupted) {
          interrupted = true
          throw new Error("interrupted after commit")
        }
      },
    }).run(),
  ).rejects.toThrow("interrupted")
  const importer = new PackedLegacyImporter(f)
  const result = await importer.run()
  expect(result).toMatchObject({ files: 1403, imported: 1402, quarantined: 0, retained: 1, artifacts: 1 })
  expect((await f.store.versioned(["notes", "0"])).revision).toBe(1n)
  expect(await f.store.scan(["storage_import_files"])).toEqual([])
  const handle = { store: f.store, artifactDirectory: f.dataRoot }
  await Storage.provide(handle, async () =>
    expect(
      Buffer.from(await Storage.readBinary(["sessions", "scope", "session", "rollout", "blobs", "content"])).toString(),
    ).toBe("original bytes"),
  )
  await importer.retire()
  await importer.retire()
  expect(await Bun.file(path.join(f.dataRoot, "notes/0.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(f.dataRoot, "sessions/scope/session/rollout/blobs/content.bin")).exists()).toBe(false)
  expect(await Bun.file(path.join(f.dataRoot, "assets/keep")).text()).toBe("retained bytes")
  expect(await fs.readdir(f.dataRoot)).not.toContain("sessions")
  expect(await fs.readdir(f.dataRoot)).not.toContain("notes")
  const restored = path.join(f.root, "restored")
  await new PackedBackup(f).restore(restored)
  expect(await Bun.file(path.join(restored, "sessions/scope/session/rollout/blobs/content.bin")).text()).toBe(
    "original bytes",
  )
  expect((await f.store.verify()).issues).toEqual([])
}, 20000)

test("owner quarantine preserves descendants without importing them, and malformed global data remains fatal", async () => {
  await using f = await fixture()
  await f.write("sessions/scope/bad/info.json", { id: "bad" })
  await f.write("sessions/scope/bad/messages/message/info.json", { id: "message" })
  const importer = new PackedLegacyImporter(f)
  expect(await importer.run()).toMatchObject({ quarantined: 2, imported: 0 })
  expect(await f.store.list(["sessions"])).toEqual([])
  expect(await f.store.read(["storage_recovery", "sessions", "bad", "info"])).toMatchObject({ blocked: true })
  await using global = await fixture()
  await global.write("meta/migration/log-session.json", "{broken")
  for (let n = 0; n < 2; n++) await expect(new PackedLegacyImporter(global).run()).rejects.toThrow("global")
  expect(await Bun.file(path.join(global.dataRoot, "meta/migration/log-session.json")).exists()).toBe(true)
})

test("retirement resumes after an unlink interruption and refuses changed originals", async () => {
  await using f = await fixture()
  for (let n = 0; n < 1100; n++) await f.write(`notes/${String(n).padStart(4, "0")}.json`, { n })
  const importer = new PackedLegacyImporter(f)
  await importer.run()
  const unlink = fs.unlink.bind(fs)
  let calls = 0
  const fault = spyOn(fs, "unlink").mockImplementation(async (filename) => {
    await unlink(filename)
    if (++calls === 1030) throw new Error("interrupted after unlink")
  })
  try {
    await expect(importer.retire()).rejects.toThrow("interrupted")
  } finally {
    fault.mockRestore()
  }
  await f.write("notes/1099.json", { changed: true })
  await expect(importer.retire()).rejects.toThrow("legacy writer")
  expect(await Bun.file(path.join(f.dataRoot, "notes/1099.json")).json()).toEqual({ changed: true })
  await f.write("notes/1099.json", { n: 1099 })
  await importer.retire()
  expect(await fs.readdir(f.dataRoot)).not.toContain("notes")
  const restored = path.join(f.root, "restored")
  await new PackedBackup(f).restore(restored)
  expect((await fs.readdir(path.join(restored, "notes"))).length).toBe(1100)
  expect(await f.store.read<{ n: number }>(["notes", "1029"])).toEqual({ n: 1029 })
}, 20000)
