import { describe, expect, test } from "bun:test"
import { FileWatcherBinding } from "../../src/file/watcher-binding"

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
})
