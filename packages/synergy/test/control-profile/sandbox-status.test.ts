import { describe, expect, test } from "bun:test"
import { SandboxBackend } from "../../src/sandbox/backend"

describe("SandboxBackend platformInfo", () => {
  test("platformInfo returns deterministic status", () => {
    const info = SandboxBackend.platformInfo()
    expect(info).toBeDefined()
    expect(typeof info.platform).toBe("string")
    expect(typeof info.available).toBe("boolean")
    // backend is either null (unsupported) or a string (supported)
    expect(info.backend === null || typeof info.backend === "string").toBe(true)
  })

  test("platformInfo is idempotent", () => {
    const a = SandboxBackend.platformInfo()
    const b = SandboxBackend.platformInfo()
    expect(a).toEqual(b)
  })
})

describe("SandboxBackend isPlatformSupported", () => {
  test("darwin is supported", () => {
    expect(SandboxBackend.isPlatformSupported("darwin")).toBe(true)
  })

  test("linux is supported", () => {
    expect(SandboxBackend.isPlatformSupported("linux")).toBe(true)
  })

  test("win32 is supported", () => {
    expect(SandboxBackend.isPlatformSupported("win32")).toBe(true)
  })

  test("macos alias is supported", () => {
    expect(SandboxBackend.isPlatformSupported("macos")).toBe(true)
  })

  test("unknown platform is not supported", () => {
    expect(SandboxBackend.isPlatformSupported("freebsd")).toBe(false)
  })
})
