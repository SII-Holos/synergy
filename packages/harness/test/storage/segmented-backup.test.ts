import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SegmentedBackup } from "../../src/storage/segmented-backup"
import { StorageMaintenance } from "../../src/storage/maintenance"

test("a completely sealed backup restores after being copied and renamed without its original home", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "segmented-portable-"))
  try {
    const data = path.join(root, "original/data")
    await Bun.write(path.join(data, "sessions/home/ses_one/info.json"), JSON.stringify({ id: "ses_one" }))
    const backup = new SegmentedBackup(data, "test-backup")
    await backup.freeze()
    await backup.global().create()
    await backup.sealSession({ scopeID: "home", sessionID: "ses_one" })
    const copied = path.join(root, "renamed-copy")
    await fs.cp(backup.backupRoot, copied, { recursive: true })
    await fs.rm(path.join(root, "original"), { recursive: true })
    const restored = path.join(root, "restored")
    await StorageMaintenance.restoreBackup(copied, restored)
    expect(await Bun.file(path.join(restored, "data/sessions/home/ses_one/info.json")).json()).toEqual({
      id: "ses_one",
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("an incomplete cohort restores both sealed and untouched sessions without SQL", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "segmented-"))
  try {
    const data = path.join(root, "data")
    for (const id of ["ses_one", "ses_two"]) {
      await fs.mkdir(path.join(data, "sessions", "home", id), { recursive: true })
      await fs.writeFile(path.join(data, "sessions", "home", id, "info.json"), JSON.stringify({ id }))
    }
    const backup = new SegmentedBackup(data, "test-backup")
    const frozen = await backup.freeze()
    expect(frozen.owners.length).toBe(2)
    expect(await Bun.file(path.join(data, "sessions/home/ses_one/info.json")).exists()).toBe(false)
    await backup.global().create()
    await backup.session({ scopeID: "home", sessionID: "ses_one" }).create()
    await fs.rm(path.join(backup.sourceRoot, "sessions/home/ses_one"), { recursive: true })
    const restored = path.join(root, "restored/data")
    await backup.restore(restored)
    for (const id of ["ses_one", "ses_two"])
      expect(await Bun.file(path.join(restored, "sessions/home", id, "info.json")).json()).toEqual({ id })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a missing unsealed source cannot be presented as an independent backup", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "segmented-missing-"))
  try {
    const data = path.join(root, "data")
    await fs.mkdir(path.join(data, "sessions/home/ses_pending"), { recursive: true })
    await fs.writeFile(path.join(data, "sessions/home/ses_pending/info.json"), "{}")
    const backup = new SegmentedBackup(data, "test-backup")
    await backup.freeze()
    await backup.global().create()
    await fs.rename(backup.sourceRoot, backup.sourceRoot + "-moved")
    await fs.mkdir(backup.sourceRoot)
    await expect(backup.restore(path.join(root, "restore/data"))).rejects.toThrow("Frozen Session source was replaced")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
