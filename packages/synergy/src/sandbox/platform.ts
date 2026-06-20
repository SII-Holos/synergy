import * as os from "os"

import type { PlatformInfo } from "./types"
import { isWindowsHelperAvailable } from "./windows"

// ------------------------------------------------------------------
// Platform detection — extracted from backend.ts (Phase 1)
// ------------------------------------------------------------------

export function detectPlatform(): string {
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

export function platformInfo(): PlatformInfo {
  const platform = detectPlatform()
  if (platform === "macos") {
    return { platform, available: true, backend: "sandbox-exec" }
  }
  if (platform === "linux") {
    const available = isBwrapAvailable()
    return { platform, available, backend: available ? "bwrap" : null }
  }
  if (platform === "windows") {
    const available = isWindowsHelperAvailable()
    return { platform, available, backend: available ? "windows-restricted-token" : null }
  }
  return { platform, available: false, backend: null }
}

function isBwrapAvailable(): boolean {
  try {
    const which = Bun.spawnSync({ cmd: ["which", "bwrap"], stdout: "pipe", stderr: "pipe" })
    return which.exitCode === 0 && which.stdout && new TextDecoder().decode(which.stdout).trim().length > 0
  } catch {
    return false
  }
}

export function getTempDir(): string {
  return os.tmpdir()
}
