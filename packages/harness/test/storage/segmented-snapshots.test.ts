import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { SegmentedBackup } from "../../src/storage/segmented-backup"
import { SnapshotProtection } from "../../src/session/snapshot-protection"

test("snapshot segments retain original paths and seal outside the global startup backup", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  await Bun.write(path.join(data, "snapshot/scope/legacy/objects/ab/object"), "historical object")
  await Bun.write(path.join(data, "notes/one.json"), "{}")
  const backup = new SegmentedBackup(data, "snapshots", undefined, 4)
  await backup.freeze()
  expect(await SnapshotProtection.active(data)).toBe(true)
  const global = await backup.global().create()
  expect(global.files).toBe(1)
  expect(await Bun.file(path.join(data, "snapshot/scope/legacy/objects/ab/object")).text()).toBe("historical object")
  expect((await backup.completeness()).independent).toBe(false)
  await backup.sealSnapshots()
  expect((await backup.completeness()).independent).toBe(true)
  const copy = path.join(tmp.path, "copy")
  await fs.cp(backup.backupRoot, copy, { recursive: true })
  await fs.rm(data, { recursive: true })
  const restored = path.join(tmp.path, "restored/data")
  await (await SegmentedBackup.open(copy)).restore(restored)
  expect(await Bun.file(path.join(restored, "snapshot/scope/legacy/objects/ab/object")).text()).toBe(
    "historical object",
  )
})

test("copied snapshot backup resolves absolute Git alternates after the original home is gone", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "source/data")
  const pool = path.join(data, "snapshot/scope/.shared")
  const repo = path.join(data, "snapshot/scope/session")
  const git = async (directory: string, args: string[], input?: string) => {
    const child = Bun.spawn(["git", "--git-dir", directory, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: input === undefined ? "ignore" : new Blob([input]),
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw new Error(stderr)
    return stdout.trim()
  }
  await fs.mkdir(path.dirname(pool), { recursive: true })
  await git(pool, ["init", "--bare", pool])
  await git(repo, ["init", "--bare", repo])
  const blob = await git(pool, ["hash-object", "-w", "--stdin"], "preserved snapshot")
  await Bun.write(path.join(repo, "objects/info/alternates"), path.join(pool, "objects") + "\n")
  expect(await git(repo, ["cat-file", "-p", blob])).toBe("preserved snapshot")
  const backup = new SegmentedBackup(data, "git-alternates", undefined, 4)
  await backup.freeze()
  await backup.global().create()
  await backup.sealSnapshots()
  const copy = path.join(tmp.path, "copied-backup")
  await fs.cp(backup.backupRoot, copy, { recursive: true })
  await fs.rm(data, { recursive: true })
  const restored = path.join(tmp.path, "restored/data")
  await (await SegmentedBackup.open(copy)).restore(restored)
  expect(await git(path.join(restored, "snapshot/scope/session"), ["cat-file", "-p", blob])).toBe("preserved snapshot")
})

test("external Git object dependencies cannot be advertised as an independent backup", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const external = path.join(tmp.path, "external/objects")
  await fs.mkdir(external, { recursive: true })
  await Bun.write(path.join(data, "snapshot/scope/session/objects/info/alternates"), external + "\n")
  const backup = new SegmentedBackup(data, "external", undefined, 4)
  await backup.freeze()
  await backup.global().create()
  await expect(backup.sealSnapshots()).rejects.toThrow("external object dependency")
  expect((await backup.completeness()).independent).toBe(false)
  expect(await SnapshotProtection.active(data)).toBe(true)
})

test("symbolic object directories never count as an independent recovery copy", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const objects = path.join(tmp.path, "outside")
  await fs.mkdir(objects, { recursive: true })
  await Bun.write(path.join(data, "snapshot/scope/session/HEAD"), "ref: refs/heads/main\n")
  await fs.symlink(objects, path.join(data, "snapshot/scope/session/objects"), "dir")
  const backup = new SegmentedBackup(data, "symbolic", undefined, 4)
  await backup.freeze()
  await backup.global().create()
  await expect(backup.sealSnapshots()).rejects.toThrow("symbolic object dependencies")
  expect((await backup.completeness()).independent).toBe(false)
})

test("background backup failures remain visible while original snapshots stay protected", async () => {
  const { Storage } = await import("../../src/storage/storage")
  const { StorageCompat } = await import("../../src/storage/compat")
  const { TransactionalStore } = await import("../../src/storage/transactional-store")
  const { SessionCompat } = await import("../../src/session/compat-import")
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const outside = path.join(tmp.path, "outside")
  await fs.mkdir(outside)
  await Bun.write(path.join(data, "snapshot/scope/session/objects/info/alternates"), outside + "\n")
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: crypto.randomUUID(),
    filename: path.join(tmp.path, "db"),
  })
  try {
    await Storage.provide({ store, artifactDirectory: data }, async () => {
      const backup = new SegmentedBackup(data, "background-error", undefined, 4)
      await backup.freeze()
      await backup.global().create()
      await StorageCompat.seedLocators(store, backup.sourceRoot, backup.backupID)
      const stop = SessionCompat.startBackgroundMigrator({ intervalMs: 5 })
      try {
        const deadline = performance.now() + 3000
        while (!(await SessionCompat.status()).backup.attention && performance.now() < deadline) await Bun.sleep(10)
        expect((await SessionCompat.status()).backup).toMatchObject({ complete: false, attention: true })
        expect(await SnapshotProtection.active(data)).toBe(true)
      } finally {
        await stop()
      }
    })
  } finally {
    await store.close()
  }
})
