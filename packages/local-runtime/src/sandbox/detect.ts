import * as os from "os"

// ------------------------------------------------------------------
// Leaf detection module — no imports from sibling sandbox modules.
// Used by platform.ts, windows.ts, macos.ts, linux.ts, and backend.ts.
// ------------------------------------------------------------------

export type PlatformName = string

export function detectPlatform(): PlatformName {
  const p = os.platform()
  if (p === "darwin") return "macos"
  if (p === "linux") return "linux"
  if (p === "win32") return "windows"
  return p
}

export function isPlatformSupported(rawPlatform: string): boolean {
  if (rawPlatform === "darwin" || rawPlatform === "macos") return true
  if (rawPlatform === "linux") return true
  if (rawPlatform === "win32" || rawPlatform === "windows") return true
  return false
}
