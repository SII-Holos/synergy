import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

export function nativeLibc(): "glibc" | "musl" {
  if (process.platform !== "linux") return "glibc"
  if (typeof SYNERGY_LIBC === "string") return SYNERGY_LIBC === "musl" ? "musl" : "glibc"
  return readFileSync("/proc/self/maps", "utf8").includes("ld-musl-") ? "musl" : "glibc"
}

declare const SYNERGY_LIBC: string | undefined

export function nativePackageName(options: { platform?: string; arch?: string; libc?: string } = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const abi = platform === "linux" ? `-${options.libc ?? nativeLibc()}` : ""
  return `@ericsanchezok/synergy-native-${platform}-${arch}${abi}`
}

export function nativeAsset(filename: string, owner: string | URL): string | undefined {
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename) || filename === "." || filename === "..")
    throw new Error("Native asset must be a package-local filename")
  try {
    const resolved = createRequire(owner).resolve(`${nativePackageName()}/${filename}`)
    return existsSync(resolved) ? resolved : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined
    throw error
  }
}
