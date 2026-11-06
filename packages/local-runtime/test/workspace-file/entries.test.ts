import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { FileEntry } from "../../src/file/entry"
import { testRuntime } from "../support/runtime"

async function fixture(fn: (directory: string) => Promise<void>) {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({ scope: await tmp.scope(), fn: () => fn(tmp.path) })
  })
}

test("entry moves reject stale source identities and never replace an existing destination", () =>
  fixture(async (directory) => {
    const source = path.join(directory, "source.txt"),
      target = path.join(directory, "target.txt")
    await Bun.write(source, "source")
    const original = (await FileEntry.inspect(source))!
    await fs.rename(source, path.join(directory, "old.txt"))
    await Bun.write(source, "replacement")
    await expect(FileEntry.move({ from: source, to: target, expectedVersion: original.version })).rejects.toThrow(
      "changed",
    )
    expect(await Bun.file(source).text()).toBe("replacement")
    await Bun.write(target, "existing")
    await expect(
      FileEntry.move({ from: source, to: target, expectedVersion: (await FileEntry.inspect(source))!.version }),
    ).rejects.toThrow()
    expect(await Bun.file(target).text()).toBe("existing")
  }))

test("directory copies preserve bytes, executable modes and symbolic links without following them", () =>
  fixture(async (directory) => {
    const source = path.join(directory, "original"),
      target = path.join(directory, "copied")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "script"), Buffer.from([0, 255, 42, 128]))
    await fs.chmod(path.join(source, "script"), 0o751)
    await fs.symlink("missing", path.join(source, "link"))
    const version = (await FileEntry.inspect(source))!.version
    await FileEntry.copy({ from: source, to: target, expectedVersion: version })
    expect(Buffer.from(await Bun.file(path.join(target, "script")).bytes())).toEqual(Buffer.from([0, 255, 42, 128]))
    if (process.platform !== "win32") expect((await fs.stat(path.join(target, "script"))).mode & 0o777).toBe(0o751)
    expect(await fs.readlink(path.join(target, "link"))).toBe("missing")
    await expect(FileEntry.copy({ from: source, to: target, expectedVersion: version })).rejects.toThrow()
    await expect(
      FileEntry.copy({ from: source, to: path.join(source, "nested"), expectedVersion: version }),
    ).rejects.toThrow()
  }))

test("entry move and removal affect the link itself, including a dangling or external link", () =>
  fixture(async (directory) => {
    await using outside = await tmpdir()
    const external = path.join(outside.path, "keep.txt")
    await Bun.write(external, "keep")
    const source = path.join(directory, "link"),
      target = path.join(directory, "moved")
    await fs.symlink(external, source)
    await FileEntry.move({ from: source, to: target, expectedVersion: (await FileEntry.inspect(source))!.version })
    expect(await fs.readlink(target)).toBe(external)
    await FileEntry.remove({ path: target, expectedVersion: (await FileEntry.inspect(target))!.version })
    expect(await Bun.file(external).text()).toBe("keep")
    await fs.symlink("missing", source)
    await FileEntry.remove({ path: source, expectedVersion: (await FileEntry.inspect(source))!.version })
    expect(await FileEntry.inspect(source)).toBeNull()
  }))

test("conditional recursive deletion refuses nonrecursive and stale directory selections", () =>
  fixture(async (directory) => {
    const folder = path.join(directory, "folder")
    await FileEntry.mkdir({ path: folder })
    await Bun.write(path.join(folder, "keep.txt"), "keep")
    const version = (await FileEntry.inspect(folder))!.version
    await expect(FileEntry.remove({ path: folder, expectedVersion: version })).rejects.toThrow()
    expect(await Bun.file(path.join(folder, "keep.txt")).text()).toBe("keep")
    await Bun.write(path.join(folder, "new.txt"), "new")
    await expect(FileEntry.remove({ path: folder, expectedVersion: version, recursive: true })).rejects.toThrow(
      "changed",
    )
    await FileEntry.remove({
      path: folder,
      expectedVersion: (await FileEntry.inspect(folder))!.version,
      recursive: true,
    })
    expect(await FileEntry.inspect(folder)).toBeNull()
  }))

test("cancelled entry mutations do not publish partial directories", () =>
  fixture(async (directory) => {
    const source = path.join(directory, "source"),
      target = path.join(directory, "target")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "file.txt"), "contents")
    const before = (await fs.readdir(directory)).sort()
    const signal = AbortSignal.abort(new Error("cancelled"))
    await expect(
      FileEntry.copy({ from: source, to: target, expectedVersion: (await FileEntry.inspect(source))!.version, signal }),
    ).rejects.toThrow("cancelled")
    expect(await FileEntry.inspect(target)).toBeNull()
    expect((await fs.readdir(directory)).sort()).toEqual(before)
  }))

test("copy publication preserves a target created after preflight and removes its own staging", () =>
  fixture(async (directory) => {
    const source = path.join(directory, "source.txt"),
      target = path.join(directory, "target.txt")
    await Bun.write(source, "source")
    let writes = 0
    await expect(
      FileEntry.copy({
        from: source,
        to: target,
        expectedVersion: (await FileEntry.inspect(source))!.version,
        async validate(file, operation) {
          if (file === target && operation === "write" && ++writes === 2) await Bun.write(target, "external")
        },
      }),
    ).rejects.toThrow("changed")
    expect(await Bun.file(target).text()).toBe("external")
    expect((await fs.readdir(directory)).filter((name) => name.startsWith(".synergy-copy-"))).toEqual([])
  }))

test("a changed destination parent cannot redirect a prepared directory move", () =>
  fixture(async (directory) => {
    const source = path.join(directory, "source"),
      parent = path.join(directory, "parent"),
      target = path.join(parent, "target")
    await fs.mkdir(source)
    await fs.mkdir(parent)
    let replaced = false
    await expect(
      FileEntry.move({
        from: source,
        to: target,
        expectedVersion: (await FileEntry.inspect(source))!.version,
        async validate(file, operation) {
          if (file !== target || operation !== "write" || replaced) return
          replaced = true
          await fs.rename(parent, path.join(directory, "old-parent"))
          await fs.mkdir(parent)
        },
      }),
    ).rejects.toThrow("changed")
    expect(await FileEntry.inspect(source)).not.toBeNull()
    expect(await FileEntry.inspect(target)).toBeNull()
  }))

test("a changed descendant aborts copy publication without changing the source", () =>
  fixture(async (directory) => {
    const source = path.join(directory, "source"),
      target = path.join(directory, "target")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "file.txt"), "original")
    let changed = false
    await expect(
      FileEntry.copy({
        from: source,
        to: target,
        expectedVersion: (await FileEntry.inspect(source))!.version,
        async validate(file, operation) {
          if (operation !== "read" || file !== source || changed) return
          changed = true
          await Bun.write(path.join(source, "file.txt"), "changed")
        },
      }),
    ).rejects.toThrow("changed")
    expect(await Bun.file(path.join(source, "file.txt")).text()).toBe("changed")
    expect(await FileEntry.inspect(target)).toBeNull()
  }))

test("failed publication cleans copied read-only directories", () =>
  fixture(async (directory) => {
    if (process.platform === "win32") return
    const source = path.join(directory, "source"),
      target = path.join(directory, "target")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "file.txt"), "contents")
    await fs.chmod(source, 0o555)
    let writes = 0
    try {
      await expect(
        FileEntry.copy({
          from: source,
          to: target,
          expectedVersion: (await FileEntry.inspect(source))!.version,
          async validate(file, operation) {
            if (file === target && operation === "write" && ++writes === 2) await fs.mkdir(target)
          },
        }),
      ).rejects.toThrow("changed")
      expect((await fs.readdir(directory)).filter((name) => name.startsWith(".synergy-copy-"))).toEqual([])
      expect(await Bun.file(path.join(source, "file.txt")).text()).toBe("contents")
    } finally {
      await fs.chmod(source, 0o755)
    }
  }))

test("case-only file renames preserve the file on a case-insensitive filesystem", () =>
  fixture(async (directory) => {
    const source = path.join(directory, "case.txt"),
      target = path.join(directory, "CASE.txt")
    await Bun.write(source, "case")
    await FileEntry.move({ from: source, to: target, expectedVersion: (await FileEntry.inspect(source))!.version })
    const names = await fs.readdir(directory)
    expect(names).toContain("CASE.txt")
    expect(names).not.toContain("case.txt")
    expect(await Bun.file(target).text()).toBe("case")
  }))
