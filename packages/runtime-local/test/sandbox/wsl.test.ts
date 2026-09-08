// ---------------------------------------------------------------------------
// sandbox/wsl.test.ts
//
// Tests for WSL1/WSL2 detection logic.
//
// The detection logic is pure: it checks for /proc/sys/fs/binfmt_misc/WSLInterop
// and reads /proc/version. On macOS neither file exists, so all WSL functions
// return false/null — these tests verify that invariant.
//
// On actual WSL, the behavior depends on the kernel version string.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/wsl.test.ts
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test"
import * as os from "os"
import { isWsl, isWsl1, isWsl2, detectWslVersion } from "../../src/sandbox/wsl"

// ==================================================================
// Cross-platform safety
// ==================================================================
describe("WSL detection on non-WSL platforms", () => {
  test("isWsl returns false on macOS", () => {
    if (os.platform() !== "darwin") return
    expect(isWsl()).toBe(false)
  })

  test("isWsl1 returns false on macOS", () => {
    if (os.platform() !== "darwin") return
    expect(isWsl1()).toBe(false)
  })

  test("isWsl2 returns false on macOS", () => {
    if (os.platform() !== "darwin") return
    expect(isWsl2()).toBe(false)
  })

  test("detectWslVersion returns null on macOS", () => {
    if (os.platform() !== "darwin") return
    expect(detectWslVersion()).toBeNull()
  })
})

// ==================================================================
// Type contracts
// ==================================================================
describe("WSL detection type contracts", () => {
  test("isWsl returns a boolean", () => {
    expect(typeof isWsl()).toBe("boolean")
  })

  test("isWsl1 returns a boolean", () => {
    expect(typeof isWsl1()).toBe("boolean")
  })

  test("isWsl2 returns a boolean", () => {
    expect(typeof isWsl2()).toBe("boolean")
  })

  test("detectWslVersion returns null or 1 or 2", () => {
    const v = detectWslVersion()
    expect(v === null || v === 1 || v === 2).toBe(true)
  })
})

// ==================================================================
// Logical consistency
// ==================================================================
describe("WSL detection logical consistency", () => {
  test("if not WSL, isWsl1 and isWsl2 are both false", () => {
    if (isWsl()) return // skip on actual WSL
    expect(isWsl1()).toBe(false)
    expect(isWsl2()).toBe(false)
    expect(detectWslVersion()).toBeNull()
  })

  test("isWsl1 and isWsl2 are mutually exclusive", () => {
    // At most one can be true; both false when not on WSL.
    expect(isWsl1() && isWsl2()).toBe(false)
  })

  test("detectWslVersion returns 1 iff isWsl1, 2 iff isWsl2", () => {
    const v = detectWslVersion()
    if (v === 1) {
      expect(isWsl1()).toBe(true)
      expect(isWsl2()).toBe(false)
    } else if (v === 2) {
      expect(isWsl1()).toBe(false)
      expect(isWsl2()).toBe(true)
    } else {
      expect(isWsl1()).toBe(false)
      expect(isWsl2()).toBe(false)
    }
  })

  test("detectWslVersion is consistent on repeated calls (cache)", () => {
    // The function uses a lazy cache; multiple calls should return the
    // same result without re-reading files.
    const v1 = detectWslVersion()
    const v2 = detectWslVersion()
    expect(v1).toBe(v2)
  })
})

// ==================================================================
// Export presence from platform.ts re-export
// ==================================================================
describe("WSL detection re-exports from platform.ts", () => {
  test("isWsl, isWsl1, isWsl2, detectWslVersion are exported from platform", async () => {
    const platform = await import("../../src/sandbox/platform")
    expect(typeof platform.isWsl).toBe("function")
    expect(typeof platform.isWsl1).toBe("function")
    expect(typeof platform.isWsl2).toBe("function")
    expect(typeof platform.detectWslVersion).toBe("function")
  })
})
