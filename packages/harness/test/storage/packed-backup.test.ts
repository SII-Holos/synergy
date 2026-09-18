import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { PackedBackup } from "../../src/storage/packed-backup"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "packed-backup-"))
  const source = path.join(root, "source")
  const backup = path.join(root, "backup")
  const restored = path.join(root, "restored")
  await fs.mkdir(source)
  const values = new Map<string, Buffer>()
  for (let n = 0; n < 2100; n++)
    values.set(
      `notes/${String(n).padStart(5, "0")}.json`,
      Buffer.from(JSON.stringify({ n, text: "evidence".repeat(20) })),
    )
  values.set("assets/large.bin", randomBytes(5 * 1024 * 1024))
  for (const [name, bytes] of values) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true })
    await fs.writeFile(path.join(source, name), bytes)
  }
  return {
    source,
    backup,
    restored,
    values,
    async [Symbol.asyncDispose]() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("packed backup restores every original byte without the business database", async () => {
  await using f = await fixture()
  const backup = new PackedBackup({ dataRoot: f.source, backupRoot: f.backup })
  const manifest = await backup.create()
  expect(manifest.files).toBe(f.values.size)
  expect(manifest.groups).toBeLessThan(10)
  await backup.restore(f.restored)
  for (const [name, bytes] of f.values) expect(await fs.readFile(path.join(f.restored, name))).toEqual(bytes)
  expect(await backup.create()).toEqual(manifest)
  const chunks = await fs.readdir(path.join(f.backup, "chunks"))
  expect(chunks.length).toBe(manifest.groups)
}, 120000)

test("a published group can resume after interruption and rejects modified source evidence", async () => {
  await using f = await fixture()
  let interrupted = false
  const first = new PackedBackup({
    dataRoot: f.source,
    backupRoot: f.backup,
    progress: () => {
      if (!interrupted) {
        interrupted = true
        throw new Error("power lost after checkpoint")
      }
    },
  })
  await expect(first.create()).rejects.toThrow("power lost")
  const resumed = new PackedBackup({ dataRoot: f.source, backupRoot: f.backup })
  await resumed.create()
  await fs.writeFile(path.join(f.source, "notes/00000.json"), "changed")
  await expect(resumed.create()).rejects.toThrow("changed")
}, 20000)

test("damaged or truncated chunks stop restoration and sealed source additions are rejected", async () => {
  await using f = await fixture()
  const backup = new PackedBackup({ dataRoot: f.source, backupRoot: f.backup })
  await backup.create()
  await fs.writeFile(path.join(f.source, "new.json"), "{}")
  await expect(backup.create()).rejects.toThrow("changed")
  const first = (await fs.readdir(path.join(f.backup, "chunks"))).sort()[0]
  await fs.truncate(path.join(f.backup, "chunks", first), 16)
  await expect(backup.restore(f.restored)).rejects.toThrow("integrity")
}, 20000)

test("capacity exhaustion before a chunk publication leaves originals available for a clean resume", async () => {
  await using f = await fixture()
  let checks = 0
  const blocked = new PackedBackup({
    dataRoot: f.source,
    backupRoot: f.backup,
    capacity: async () => {
      if (++checks > 1) throw Object.assign(new Error("capacity reserve reached"), { code: "ENOSPC" })
    },
  })
  await expect(blocked.create()).rejects.toMatchObject({ code: "ENOSPC" })
  expect(await fs.readFile(path.join(f.source, "notes/00000.json"))).toEqual(f.values.get("notes/00000.json")!)
  const resumed = new PackedBackup({ dataRoot: f.source, backupRoot: f.backup })
  expect((await resumed.create()).files).toBe(f.values.size)
  await resumed.restore(f.restored)
  expect(await fs.readFile(path.join(f.restored, "assets/large.bin"))).toEqual(f.values.get("assets/large.bin")!)
}, 120000)
