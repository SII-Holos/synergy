import * as fs from "fs"
import * as os from "os"

// ------------------------------------------------------------------
// WSL detection
//
// Distinguishes WSL1 (kernel limitations, no bwrap namespace sandbox)
// from WSL2 (fully supported). Used by the Linux backend and readiness
// checks to provide clear skip reasons instead of cryptic errors.
// ------------------------------------------------------------------

const WSL_INTEROP_PATH = "/proc/sys/fs/binfmt_misc/WSLInterop"
const PROC_VERSION_PATH = "/proc/version"

let cachedWslVersion: 1 | 2 | null | undefined

/**
 * Read the /proc/version kernel string if available.
 * Returns null on non-Linux or if the file cannot be read.
 */
function readProcVersion(): string | null {
  try {
    if (os.platform() !== "linux") return null
    return fs.readFileSync(PROC_VERSION_PATH, "utf-8")
  } catch {
    return null
  }
}

/**
 * True when running inside any WSL environment (WSL1 or WSL2).
 */
export function isWsl(): boolean {
  try {
    return os.platform() === "linux" && fs.existsSync(WSL_INTEROP_PATH)
  } catch {
    return false
  }
}

/**
 * Detect WSL version (1 or 2) from kernel version string.
 *
 * Returns:
 *   - 1 for WSL1
 *   - 2 for WSL2
 *   - null for native Linux (no WSL interop file)
 *
 * Uses a lazy cache because reading /proc/version is cheap and the
 * kernel won't change during the process lifetime.
 */
export function detectWslVersion(): 1 | 2 | null {
  if (cachedWslVersion !== undefined) return cachedWslVersion

  if (!isWsl()) {
    cachedWslVersion = null
    return null
  }

  const version = readProcVersion()
  if (!version) {
    cachedWslVersion = null
    return null
  }

  if (version.includes("microsoft-standard-WSL2")) {
    cachedWslVersion = 2
  } else {
    cachedWslVersion = 1
  }

  return cachedWslVersion
}

/**
 * True when running under WSL1 (non-WSL2 WSL).
 * WSL1 lacks the kernel features required for bwrap namespace sandboxing.
 */
export function isWsl1(): boolean {
  return detectWslVersion() === 1
}

/**
 * True when running under WSL2.
 * WSL2 has full kernel support for bwrap / user namespaces.
 */
export function isWsl2(): boolean {
  return detectWslVersion() === 2
}
