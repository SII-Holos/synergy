import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util/filesystem"
import { File } from "../../src/file"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("Filesystem.contains", () => {
  test("allows paths within project", () => {
    expect(Filesystem.contains("/project", "/project/src")).toBe(true)
    expect(Filesystem.contains("/project", "/project/src/file.ts")).toBe(true)
    expect(Filesystem.contains("/project", "/project")).toBe(true)
  })

  test("blocks ../ traversal", () => {
    expect(Filesystem.contains("/project", "/project/../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/project/src/../../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
  })

  test("blocks absolute paths outside project", () => {
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
    expect(Filesystem.contains("/project", "/tmp/file")).toBe(false)
    expect(Filesystem.contains("/home/user/project", "/home/user/other")).toBe(false)
  })

  test("handles prefix collision edge cases", () => {
    expect(Filesystem.contains("/project", "/project-other/file")).toBe(false)
    expect(Filesystem.contains("/project", "/projectfile")).toBe(false)
  })

  test("rejects Windows cross-drive paths", () => {
    if (process.platform !== "win32") return
    expect(Filesystem.contains("C:\\project", "D:\\project\\file.txt")).toBe(false)
  })
})

describe("plugin asset realpath containment", () => {
  test("rejects symlink targets that escape the plugin directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "plugin", "dist"), { recursive: true })
        await Bun.write(path.join(dir, "outside.txt"), "outside")
      },
    })

    const pluginDir = path.join(tmp.path, "plugin")
    const linkPath = path.join(pluginDir, "dist", "escape.txt")
    try {
      await fs.symlink(path.join(tmp.path, "outside.txt"), linkPath)
    } catch {
      return
    }

    const real = await fs.realpath(linkPath)
    expect(Filesystem.contains(pluginDir, real)).toBe(false)
  })
})

/*
 * Integration tests for File.read() and File.list() path traversal protection.
 *
 * These tests cover the legacy File namespace used by older internal tools.
 * Workspace file HTTP routes use WorkspaceFileService and have separate
 * boundary coverage in test/workspace-file.
 */
describe("File.read path traversal protection", () => {
  test("rejects ../ traversal attempting to read /etc/passwd", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "allowed.txt"), "allowed content")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(File.read("../../../etc/passwd")).rejects.toThrow("Access denied: path escapes project directory")
      },
    })
  })

  test("rejects deeply nested traversal", async () => {
    await using tmp = await tmpdir()

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(File.read("src/nested/../../../../../../../etc/passwd")).rejects.toThrow(
          "Access denied: path escapes project directory",
        )
      },
    })
  })

  test("allows valid paths within project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "valid.txt"), "valid content")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await File.read("valid.txt")
        expect(result.content).toBe("valid content")
      },
    })
  })
})

describe("File.list path traversal protection", () => {
  test("rejects ../ traversal attempting to list /etc", async () => {
    await using tmp = await tmpdir()

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(File.list("../../../etc")).rejects.toThrow("Access denied: path escapes project directory")
      },
    })
  })

  test("allows valid subdirectory listing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "file.txt"), "content")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await File.list("subdir")
        expect(Array.isArray(result)).toBe(true)
      },
    })
  })
})
