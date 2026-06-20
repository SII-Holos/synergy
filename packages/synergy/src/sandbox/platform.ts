import * as os from "os"

import type { PlatformInfo } from "./types"
import { detectPlatform } from "./detect"
import { isWindowsHelperAvailable } from "./windows"
import { isLinuxHelperAvailable } from "./linux"
// Re-export detection primitives for backward compat
export { detectPlatform, isPlatformSupported } from "./detect"
export type { PlatformName } from "./detect"

export function platformInfo(): PlatformInfo {
  const platform = detectPlatform()
  if (platform === "macos") {
    return { platform, available: true, backend: "sandbox-exec" }
  }
  if (platform === "linux") {
    const available = isLinuxHelperAvailable()
    return { platform, available, backend: available ? "synergy-sandbox-linux" : null }
  }
  if (platform === "windows") {
    const available = isWindowsHelperAvailable()
    return { platform, available, backend: available ? "windows-restricted-token" : null }
  }
  return { platform, available: false, backend: null }
}

export function isBwrapAvailable(): boolean {
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
