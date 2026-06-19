import * as os from "os"

import type { PlatformInfo } from "./types"

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
  let available = false
  let backend: string | null = null

  if (platform === "macos") {
    available = true
    backend = "sandbox-exec"
  } else if (platform === "linux") {
    available = isBwrapAvailable()
    backend = available ? "bwrap" : null
  } else if (platform === "windows") {
    // Phase 3: detect Windows helper
    available = false
    backend = null
  }

  return { platform, available, backend }
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
