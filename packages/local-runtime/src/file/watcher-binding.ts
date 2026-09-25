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
    if ((input.platform ?? process.platform) === "linux")
      return [builtPath(input), modulePath(), packagedPath(input)].some(existsSync)
    return resolvable(packageName(input)) || existsSync(packagedPath(input))
  }

  function modulePath() {
    return path.resolve(import.meta.dir, "../watcher.node")
  }

  export function builtPath(input: { arch?: string; libc?: string } = {}) {
    const arch = input.arch ?? process.arch
    const libc = input.libc ?? (typeof SYNERGY_LIBC === "string" ? SYNERGY_LIBC : "glibc")
    return path.resolve(import.meta.dir, "../../.artifacts/watcher", `linux-${arch}-${libc}`, "watcher.node")
  }

  export function load(input: { platform?: NodeJS.Platform; arch?: string; libc?: string; execPath?: string } = {}) {
    if ((input.platform ?? process.platform) === "linux") {
      for (const file of [builtPath(input), modulePath(), packagedPath(input)]) {
        if (!existsSync(file)) continue
        const binding = require(file)
        if (binding.synergyWatcherPatch !== "parcel-2.5.6-eintr-1")
          throw new Error("Linux watcher binding has no verified EINTR fix")
        return binding
      }
      throw new Error(
        "Verified Linux watcher binding is unavailable; run bun dev prepare or reinstall the runtime package",
      )
    }
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
