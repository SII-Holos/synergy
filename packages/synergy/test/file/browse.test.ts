import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { File } from "../../src/file"
import { tmpdir } from "../fixture/fixture"

async function mkdirp(...parts: string[]) {
  await fs.mkdir(path.join(...parts), { recursive: true })
}

describe("File.browse", () => {
  test("returns direct child directories for empty query", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "alpha")
        await mkdirp(dir, "beta")
        await Bun.write(path.join(dir, "note.txt"), "not a directory")
      },
    })

    const results = await File.browse({ path: tmp.path, query: "", limit: 10, depth: 3 })
    expect(results.map((item) => path.basename(item))).toEqual(["alpha", "beta"])
  })

  test("respects limit for empty query", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "a")
        await mkdirp(dir, "b")
        await mkdirp(dir, "c")
      },
    })

    const results = await File.browse({ path: tmp.path, query: "", limit: 2, depth: 3 })
    expect(results).toHaveLength(2)
  })

  test("does not recurse for empty query", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "parent", "nested")
      },
    })

    const results = await File.browse({ path: tmp.path, query: "", limit: 10, depth: 3 })
    expect(results).toContain(path.join(tmp.path, "parent"))
    expect(results).not.toContain(path.join(tmp.path, "parent", "nested"))
  })

  test("matches fuzzy query relative to the requested base", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "projects", "synergy-app")
        await mkdirp(dir, "projects", "unrelated")
        await mkdirp(dir, "archives")
      },
    })

    const base = path.join(tmp.path, "projects")
    const results = await File.browse({ path: base, query: "syn app", limit: 10, depth: 3 })
    expect(results).toContain(path.join(base, "synergy-app"))
    expect(results).not.toContain(path.join(base, "unrelated"))
  })

  test("prioritizes direct child matches before deeper matches", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "focus")
        await mkdirp(dir, "archive", "focus-old")
      },
    })

    const results = await File.browse({ path: tmp.path, query: "focus", limit: 10, depth: 3 })
    expect(results[0]).toBe(path.join(tmp.path, "focus"))
    expect(results).toContain(path.join(tmp.path, "archive", "focus-old"))
  })

  test("does not descend into ignored heavy directories by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "node_modules", "matching-project")
        await mkdirp(dir, "dist", "matching-build")
        await mkdirp(dir, "AppData", "matching-cache")
        await mkdirp(dir, "visible", "matching-project")
      },
    })

    const results = await File.browse({ path: tmp.path, query: "matching", limit: 10, depth: 3 })
    expect(results).toContain(path.join(tmp.path, "visible", "matching-project"))
    const relatives = results.map((item) => path.relative(tmp.path, item))
    expect(relatives.some((item) => item.startsWith(`node_modules${path.sep}`))).toBe(false)
    expect(relatives.some((item) => item.startsWith(`dist${path.sep}`))).toBe(false)
    expect(relatives.some((item) => item.startsWith(`AppData${path.sep}`))).toBe(false)
  })

  test("skips hidden nested directories by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "visible", ".cache", "hidden-match")
        await mkdirp(dir, "visible", "normal-match")
      },
    })

    const results = await File.browse({ path: tmp.path, query: "match", limit: 10, depth: 4 })
    expect(results).toContain(path.join(tmp.path, "visible", "normal-match"))
    expect(results).not.toContain(path.join(tmp.path, "visible", ".cache", "hidden-match"))
  })

  test("returns empty array for missing or non-directory base", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "not a directory")
      },
    })

    await expect(File.browse({ path: path.join(tmp.path, "missing") })).resolves.toEqual([])
    await expect(File.browse({ path: path.join(tmp.path, "file.txt") })).resolves.toEqual([])
  })

  test("path-like query narrows to the longest existing parent", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdirp(dir, "workspace", "focus-target")
        await mkdirp(dir, "other", "focus-target")
      },
    })

    const results = await File.browse({ path: tmp.path, query: `workspace${path.sep}focus`, limit: 10, depth: 3 })
    expect(results).toContain(path.join(tmp.path, "workspace", "focus-target"))
    expect(results).not.toContain(path.join(tmp.path, "other", "focus-target"))
  })
})
