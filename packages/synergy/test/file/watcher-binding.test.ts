import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FileWatcherBinding } from "../../src/file/watcher-binding"

// A platform whose binding package is never installed in this workspace, used
// to exercise the packaged fallback without mocking module resolution.
const UNINSTALLED_PLATFORM = "freebsd"

describe("FileWatcherBinding package name", () => {
  test("falls back to glibc for an unbundled Linux source runtime", () => {
    expect(FileWatcherBinding.packageName({ platform: "linux", arch: "x64" })).toBe("@parcel/watcher-linux-x64-glibc")
  })

  test("preserves an injected Linux libc", () => {
    expect(FileWatcherBinding.packageName({ platform: "linux", arch: "x64", libc: "musl" })).toBe(
      "@parcel/watcher-linux-x64-musl",
    )
  })

  test("does not add a libc suffix on other platforms", () => {
    expect(FileWatcherBinding.packageName({ platform: "darwin", arch: "arm64" })).toBe("@parcel/watcher-darwin-arm64")
    expect(FileWatcherBinding.packageName({ platform: "win32", arch: "x64" })).toBe("@parcel/watcher-win32-x64")
  })

  test("detects a missing watcher binding package without executing it", () => {
    expect(FileWatcherBinding.resolvable("zod")).toBe(true)
    expect(FileWatcherBinding.resolvable("@parcel/watcher-not-installed-4f8a2c")).toBe(false)
  })
})

describe("FileWatcherBinding packaged runtime fallback", () => {
  test("resolves watcher.node next to the executable", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synergy-watcher-packaged-"))
    const execPath = path.join(root, "bin", "synergy")
    expect(FileWatcherBinding.packagedPath({ execPath })).toBe(path.join(root, "watcher.node"))
  })

  test("reports availability from a packaged watcher.node when the npm package is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-watcher-available-"))
    try {
      const execPath = path.join(root, "bin", "synergy")
      const packaged = path.join(root, "watcher.node")
      await fs.mkdir(path.dirname(packaged), { recursive: true })
      await fs.writeFile(packaged, "binding")
      expect(FileWatcherBinding.available({ platform: UNINSTALLED_PLATFORM, execPath })).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("reports unavailability when neither the npm package nor a packaged binding exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-watcher-unavailable-"))
    try {
      const execPath = path.join(root, "bin", "synergy")
      expect(FileWatcherBinding.available({ platform: UNINSTALLED_PLATFORM, execPath })).toBe(false)
      expect(() => FileWatcherBinding.loadPackaged({ execPath })).toThrow(/binding is unavailable/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("prefers the npm package over a packaged binding when both exist", async () => {
    // The source-mode require of the real package succeeds in this workspace,
    // so load() must resolve it without touching the packaged fallback path.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-watcher-precedence-"))
    try {
      const execPath = path.join(root, "bin", "synergy")
      const packaged = path.join(root, "watcher.node")
      await fs.mkdir(path.dirname(packaged), { recursive: true })
      await fs.writeFile(packaged, "packaged")
      if (FileWatcherBinding.resolvable(FileWatcherBinding.packageName())) {
        const loaded = FileWatcherBinding.load({ execPath })
        expect(loaded).not.toBe("packaged")
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
