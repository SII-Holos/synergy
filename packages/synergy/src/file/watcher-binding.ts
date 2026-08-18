import path from "path"
import { existsSync } from "fs"

declare const SYNERGY_LIBC: string | undefined

export namespace FileWatcherBinding {
  export function packageName(
    input: {
      platform?: NodeJS.Platform
      arch?: string
      libc?: string
    } = {},
  ) {
    const platform = input.platform ?? process.platform
    const arch = input.arch ?? process.arch
    if (platform !== "linux") return `@parcel/watcher-${platform}-${arch}`
    const libc = input.libc ?? (typeof SYNERGY_LIBC === "string" ? SYNERGY_LIBC : "glibc")
    return `@parcel/watcher-${platform}-${arch}-${libc}`
  }

  /**
   * Compiled runtimes do not embed the dynamic require of the platform binding,
   * so packaging ships `watcher.node` beside the executable (same layout as the
   * `vec0.*` SQLite extension) and the loader falls back to that absolute path.
   */
  export function packagedPath(input: { execPath?: string } = {}) {
    const execPath = input.execPath ?? process.execPath
    return path.resolve(path.dirname(execPath), "..", "watcher.node")
  }

  export function resolvable(name: string): boolean {
    try {
      require.resolve(name)
      return true
    } catch {
      return false
    }
  }

  export function available(
    input: { platform?: NodeJS.Platform; arch?: string; libc?: string; execPath?: string } = {},
  ): boolean {
    return resolvable(packageName(input)) || existsSync(packagedPath(input))
  }

  export function load(input: { platform?: NodeJS.Platform; arch?: string; libc?: string; execPath?: string } = {}) {
    try {
      return require(packageName(input))
    } catch {
      return loadPackaged(input)
    }
  }

  export function loadPackaged(input: { execPath?: string } = {}) {
    const packaged = packagedPath(input)
    if (!existsSync(packaged)) {
      throw new Error(
        `@parcel/watcher platform binding is unavailable: tried ${packageName()} and ${packaged}. ` +
          "File watching is disabled; install the binding package or ship watcher.node beside the executable.",
      )
    }
    return require(packaged)
  }
}
