import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import {
  scanDir,
  scanCategories,
  formatSize,
  dirExists,
  isDirEmpty,
  checkDiskSpace,
  copyDirSkipExisting,
  archiveExclusions,
} from "../../src/cli/cmd/data/shared"

test("data copy keeps destination records, excludes derived stores, and reports nested files and links", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source")
  const target = path.join(tmp.path, "target")
  await fs.mkdir(path.join(source, "nested"), { recursive: true })
  await fs.mkdir(path.join(source, "snapshot"), { recursive: true })
  await Bun.write(path.join(source, "keep.txt"), "source")
  await Bun.write(path.join(source, "nested/new.txt"), "new")
  await Bun.write(path.join(source, "snapshot/derived"), "skip")
  await fs.symlink("nested/new.txt", path.join(source, "link"))
  await Bun.write(path.join(target, "keep.txt"), "destination")
  const progress: string[] = []
  const result = await copyDirSkipExisting(
    source,
    target,
    (item) => progress.push(item.currentFile),
    undefined,
    undefined,
    archiveExclusions("data"),
  )
  expect(result).toEqual({ copied: 2, skipped: 1 })
  expect(await Bun.file(path.join(target, "keep.txt")).text()).toBe("destination")
  expect(await Bun.file(path.join(target, "nested/new.txt")).text()).toBe("new")
  expect(await fs.readlink(path.join(target, "link"))).toBe("nested/new.txt")
  expect(await dirExists(path.join(target, "snapshot"))).toBe(false)
  expect(progress.sort()).toEqual(["keep.txt", "link", path.join("nested", "new.txt")].sort())
  expect(await copyDirSkipExisting(source, target, undefined, undefined, undefined, ["snapshot"])).toEqual({
    copied: 0,
    skipped: 3,
  })
  expect(await scanDir(target)).toEqual({ size: 14, fileCount: 2 })
  expect(await scanDir(path.join(tmp.path, "missing"))).toEqual({ size: 0, fileCount: 0 })
  expect(await isDirEmpty(target)).toBe(false)
  expect(await isDirEmpty(path.join(tmp.path, "missing"))).toBe(true)
})

test("data size summaries combine categories and disk-space checks reserve space", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "data/a.json"), "{}")
  await Bun.write(path.join(tmp.path, "media/image"), "pixels")
  await Bun.write(path.join(tmp.path, "assets/font"), "font")
  const sizes = await scanCategories(tmp.path)
  expect(sizes.get("core")).toEqual({ size: 2, fileCount: 1 })
  expect(sizes.get("media")).toEqual({ size: 10, fileCount: 2 })
  expect(sizes.get("logs")).toEqual({ size: 0, fileCount: 0 })
  expect([formatSize(15), formatSize(1024), formatSize(1024 ** 2), formatSize(1024 ** 3)]).toEqual([
    "15 B",
    "1.0 KB",
    "1.0 MB",
    "1.0 GB",
  ])
  const available = await checkDiskSpace(path.join(tmp.path, "nested/target"), 1)
  expect(available.ok).toBe(true)
  if (available.available !== null)
    expect((await checkDiskSpace(path.join(tmp.path, "nested/target"), Number.MAX_SAFE_INTEGER)).ok).toBe(false)
  expect(archiveExclusions("cache")).toEqual(["snapshot-index"])
  expect(archiveExclusions("state")).toEqual([path.join("daemon", "runtime-lock.json")])
  expect(archiveExclusions("media")).toEqual([])
})
