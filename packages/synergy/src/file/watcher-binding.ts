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
}
