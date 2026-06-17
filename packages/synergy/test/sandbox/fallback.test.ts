import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// sandbox/fallback.test.ts
//
// Tests for the SandboxRuntime fallback policy — what happens when sandbox
// is unavailable, explicitly disabled, or misconfigured.
//
// These tests encode the DESIGN CONTRACT before implementation exists.
// They MUST fail (RED) with module-not-found or type errors until
// packages/synergy/src/sandbox/fallback.ts (or runtime.ts) is created.
// ---------------------------------------------------------------------------

describe("sandbox fallback policy defaults", () => {
  test("fallback to warn when sandbox is unavailable and policy is unset", () => {
    // When no explicit fallback policy is configured and the sandbox runtime
    // reports as unavailable, the system MUST default to "warn" — not "allow"
    // (silent downgrade), not "deny" (breaking users who can't install sandbox).
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const platform = SandboxRuntime.detectPlatform()

    if (platform !== "macos") {
      // On non-macOS, sandbox is unavailable by definition.
      // The fallback policy MUST resolve to "warn" by default.
      const fallback = SandboxRuntime.resolveFallback()
      expect(fallback.policy).toBe("warn")
      expect(fallback.reason).toContain("unavailable")
    }
  })

  test("fallback to warn does not block execution", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const platform = SandboxRuntime.detectPlatform()

    if (platform !== "macos") {
      const fallback = SandboxRuntime.resolveFallback()
      // "warn" policy means execution proceeds with a warning, not aborted
      expect(fallback.allowExecution).toBe(true)
      // There should be a warning message for the user
      expect(typeof fallback.message).toBe("string")
      expect(fallback.message.length).toBeGreaterThan(0)
    }
  })

  test("fallback policy is deterministic — same result on repeated calls", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const f1 = SandboxRuntime.resolveFallback()
    const f2 = SandboxRuntime.resolveFallback()
    expect(f1.policy).toBe(f2.policy)
    expect(f1.allowExecution).toBe(f2.allowExecution)
  })
})

describe("sandbox explicit disable (enabled=false)", () => {
  test("sandbox.enabled=false disables sandbox with no unavailable warning", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    // When the user explicitly sets sandbox.enabled=false, the system must
    // NOT produce a warning about sandbox being unavailable. The user knows
    // what they're doing. This is a quiet disable.
    const fallback = SandboxRuntime.resolveFallback({ enabled: false })

    expect(fallback.policy).toBe("allow")
    expect(fallback.allowExecution).toBe(true)
    // No warning message when explicitly disabled — the user chose this
    expect(fallback.message).toBe("")
  })

  test("sandbox.enabled=false skip availability check entirely", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    // When enabled=false, resolveFallback must return a result that does
    // NOT consult isAvailable() at all. We can detect this by checking
    // that the reason field does not mention "unavailable."
    const fallback = SandboxRuntime.resolveFallback({ enabled: false })

    expect(fallback.reason).not.toContain("unavailable")
    expect(fallback.reason).toContain("disabled")
  })

  test("sandbox.enabled=false does not depend on platform", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    // The disabled path must be platform-independent — it should return
    // the same result on any OS.
    const fallback = SandboxRuntime.resolveFallback({ enabled: false })

    // No profile rules, no platform checks
    expect(fallback.policy).toBe("allow")
  })
})

describe("sandbox enabled=true but unavailable", () => {
  test("sandbox.enabled=true on unsupported platform produces actionable error", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const platform = SandboxRuntime.detectPlatform()

    if (platform !== "macos") {
      // When the user explicitly wants sandbox (enabled=true) but the platform
      // doesn't support it, we must tell them clearly.
      const fallback = SandboxRuntime.resolveFallback({ enabled: true })

      expect(fallback.policy).toBe("warn")
      expect(fallback.allowExecution).toBe(true) // don't block entirely
      expect(fallback.message).toContain("not available")
      expect(fallback.reason).toContain("unavailable")
    }
  })
})

describe("sandbox fallback policy override", () => {
  test("explicit fallbackPolicy='deny' when unavailable blocks execution", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const platform = SandboxRuntime.detectPlatform()

    if (platform !== "macos") {
      // User configured fallbackPolicy="deny" — when sandbox is unavailable,
      // execution must be blocked (not just warned).
      const fallback = SandboxRuntime.resolveFallback({
        fallbackPolicy: "deny",
      })

      expect(fallback.policy).toBe("deny")
      expect(fallback.allowExecution).toBe(false)
    }
  })

  test("explicit fallbackPolicy='allow' when unavailable silently proceeds", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const platform = SandboxRuntime.detectPlatform()

    if (platform !== "macos") {
      // User accepts the risk — no warning, just proceed
      const fallback = SandboxRuntime.resolveFallback({
        fallbackPolicy: "allow",
      })

      expect(fallback.policy).toBe("allow")
      expect(fallback.allowExecution).toBe(true)
      expect(fallback.message).toBe("")
    }
  })

  test("fallbackPolicy accepts only valid enum values", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    // Invalid policy values must be rejected with a clear error
    expect(() =>
      SandboxRuntime.resolveFallback({
        fallbackPolicy: "silent" as any,
      }),
    ).toThrow()
  })
})

describe("sandbox config shape validation", () => {
  test("SandboxRuntime.validateConfig rejects unknown config keys", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    expect(() =>
      SandboxRuntime.validateConfig({
        enabled: true,
        unknownKey: 42,
      } as any),
    ).toThrow()
  })

  test("SandboxRuntime.validateConfig accepts valid minimal config", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    // A valid config object must pass validation without throwing
    expect(() =>
      SandboxRuntime.validateConfig({
        enabled: false,
      }),
    ).not.toThrow()

    expect(() =>
      SandboxRuntime.validateConfig({
        enabled: true,
        fallbackPolicy: "warn",
      }),
    ).not.toThrow()
  })

  test("SandboxRuntime.validateConfig rejects boolean for fallbackPolicy", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    expect(() =>
      SandboxRuntime.validateConfig({
        fallbackPolicy: true as any,
      }),
    ).toThrow()
  })
})
