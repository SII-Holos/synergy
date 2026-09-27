import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FileLink } from "@ericsanchezok/synergy-local-runtime/file/link"
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
  expect(await fs.readlink(path.join(target, "link"))).toBe(await fs.readlink(path.join(source, "link")))
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

test("data merge never follows destination links or replaces a dangling link", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source")
  const target = path.join(tmp.path, "target")
  const outside = path.join(tmp.path, "outside")
  await fs.mkdir(path.join(source, "nested"), { recursive: true })
  await Bun.write(path.join(source, "nested/new.txt"), "new")
  await fs.mkdir(target)
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(target, "nested"))
  await expect(copyDirSkipExisting(source, target)).rejects.toThrow("symbolic link")
  expect(await Bun.file(path.join(outside, "new.txt")).exists()).toBe(false)
  await fs.unlink(path.join(target, "nested"))
  await fs.mkdir(path.join(target, "nested"))
  await fs.symlink(path.join(outside, "absent"), path.join(target, "nested/new.txt"))
  expect(await copyDirSkipExisting(source, target)).toEqual({ copied: 0, skipped: 1 })
  expect(await Bun.file(path.join(outside, "absent")).exists()).toBe(false)
})

test("data copies preserve native link kinds after their targets disappear", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source")
  const target = path.join(tmp.path, "target")
  await fs.mkdir(source)
  for (const type of ["file", "dir", "junction"] as const) {
    const destination = path.join(tmp.path, type)
    if (type === "file") await fs.writeFile(destination, "bytes")
    else await fs.mkdir(destination)
    await fs.symlink(destination, path.join(source, type), type)
    await fs.rm(destination, { recursive: true })
  }
  expect(await copyDirSkipExisting(source, target)).toEqual({ copied: 3, skipped: 0 })
  for (const type of ["file", "dir", "junction"] as const) {
    expect(await fs.readlink(path.join(target, type))).toBe(await fs.readlink(path.join(source, type)))
    expect(FileLink.type(path.join(target, type))).toBe(process.platform === "win32" ? type : undefined)
  }
})

test("durable Home copies retain read-only mode and cannot replace a concurrent destination", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source"),
    target = path.join(tmp.path, "target")
  await fs.mkdir(source)
  await fs.mkdir(target)
  const file = path.join(source, "readonly")
  await fs.writeFile(file, "immutable bytes")
  await fs.chmod(file, 0o444)
  const mode = (await fs.stat(file)).mode & 0o777
  expect(await copyDirSkipExisting(source, target)).toEqual({ copied: 1, skipped: 0 })
  expect(await fs.readFile(path.join(target, "readonly"), "utf8")).toBe("immutable bytes")
  expect((await fs.stat(path.join(target, "readonly"))).mode & 0o777).toBe(mode)
  await fs.writeFile(path.join(source, "raced"), "source")
  const copy = fs.copyFile
  using publish = spyOn(fs, "copyFile").mockImplementation(async (...args) => {
    await copy(...args)
    await fs.writeFile(path.join(target, "raced"), "newer destination")
  })
  expect(await copyDirSkipExisting(source, target)).toEqual({ copied: 0, skipped: 2 })
  expect(await fs.readFile(path.join(target, "raced"), "utf8")).toBe("newer destination")
  expect((await fs.readdir(target)).sort()).toEqual(["raced", "readonly"])
})
