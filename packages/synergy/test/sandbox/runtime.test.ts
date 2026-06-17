import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"

// ---------------------------------------------------------------------------
// sandbox/runtime.test.ts
//
// Tests for the SandboxRuntime abstraction — platform detection, availability
// checks, and wrapper/profile generation.
//
// These tests encode the DESIGN CONTRACT before implementation exists.
// They MUST fail (RED) with module-not-found or type errors until
// packages/synergy/src/sandbox/runtime.ts is created.
// ---------------------------------------------------------------------------

describe("sandbox.SandboxRuntime platform detection", () => {
  test("detectPlatform returns macos on darwin", () => {
    // SandboxRuntime.detectPlatform() must be a pure function returning the
    // current OS name as a fixed string tag — no dynamic probing, no I/O.
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const platform = SandboxRuntime.detectPlatform()
    expect(typeof platform).toBe("string")
    // On macOS CI/dev, platform matches the Node os.platform() convention
    if (os.platform() === "darwin") {
      expect(platform).toBe("macos")
    }
  })

  test("detectPlatform returns consistent values regardless of env", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const p1 = SandboxRuntime.detectPlatform()
    const p2 = SandboxRuntime.detectPlatform()
    expect(p1).toBe(p2)
  })
})

describe("sandbox.SandboxRuntime availability", () => {
  test("isAvailable returns a boolean", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const available = SandboxRuntime.isAvailable()
    expect(typeof available).toBe("boolean")
  })

  test("isAvailable does not throw even if sandbox executable is missing", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    // The function must be safe to call unconditionally — no uncaught errors
    // even when sandbox binaries don't exist on the system.
    expect(() => SandboxRuntime.isAvailable()).not.toThrow()
  })

  test("isAvailable returns false when sandbox support is absent on this platform", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const platform = SandboxRuntime.detectPlatform()
    // If the platform has no sandbox implementation at all, isAvailable must
    // return false — not throw, not return undefined.
    if (platform !== "macos") {
      expect(SandboxRuntime.isAvailable()).toBe(false)
    }
  })
})

describe("sandbox.SandboxRuntime wrapper generation (macOS profile)", () => {
  test("generateWrapper produces a SandboxWrapper object with required fields", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const workspace = "/Users/test/my-project"
    const writableRoots = [path.join(workspace, ".synergy")]
    const protectedPaths = ["/etc", "/usr", os.homedir()]

    const wrapper = SandboxRuntime.generateWrapper({
      platform: "macos",
      workspace,
      writableRoots,
      protectedPaths,
    })

    // The wrapper MUST be an object (not null, not undefined)
    expect(wrapper).toBeDefined()
    expect(typeof wrapper).toBe("object")

    // Required fields on the SandboxWrapper interface
    expect(wrapper.command).toBeDefined()
    expect(Array.isArray(wrapper.profileRules)).toBe(true)
    expect(wrapper.workspaceWritable).toBe(true)
  })

  test("generateWrapper includes the workspace directory as a writable root in profile rules", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const workspace = "/Users/test/my-project"
    const writableRoots = [path.join(workspace, ".synergy")]

    const wrapper = SandboxRuntime.generateWrapper({
      platform: "macos",
      workspace,
      writableRoots,
      protectedPaths: [],
    })

    // The sandbox profile MUST allow writes inside the workspace directory.
    // On macOS this typically means a sandbox-profile rule that permits
    // subpath access to the workspace.
    const profileStr = wrapper.profileRules.join("\n")
    expect(profileStr).toContain(workspace)
  })

  test("generateWrapper includes .synergy as writable subpath by default", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const workspace = "/Users/test/my-project"
    const synergyDir = path.join(workspace, ".synergy")

    const wrapper = SandboxRuntime.generateWrapper({
      platform: "macos",
      workspace,
      writableRoots: [synergyDir],
      protectedPaths: [],
    })

    const profileStr = wrapper.profileRules.join("\n")
    expect(profileStr).toContain(synergyDir)
  })

  test("generateWrapper protects standard system paths", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    const wrapper = SandboxRuntime.generateWrapper({
      platform: "macos",
      workspace: "/Users/test/my-project",
      writableRoots: [],
      protectedPaths: ["/System", "/etc", "/usr/local/bin"],
    })

    const profileStr = wrapper.profileRules.join("\n")
    // Protected paths must appear in the profile with deny-write semantics
    for (const p of ["/System", "/etc"]) {
      // At minimum the path string must appear — real profile uses (deny ...)
      // but we're testing the contract, not exact syntax.
      expect(profileStr).toContain(p)
    }
  })

  test("generateWrapper does not require filesystem access — pure string assembly", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    // This test asserts that generateWrapper can be called with completely
    // synthesized paths and no real filesystem. It must not stat or access
    // disk to produce the wrapper.
    const nonexistent = "/nonexistent-workspace-" + Math.random().toString(36).slice(2)
    expect(() =>
      SandboxRuntime.generateWrapper({
        platform: "macos",
        workspace: nonexistent,
        writableRoots: [],
        protectedPaths: [],
      }),
    ).not.toThrow()
  })

  test("generateWrapper rejects unsupported platforms with a clear error", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    expect(() =>
      SandboxRuntime.generateWrapper({
        platform: "unsupported_os",
        workspace: "/tmp/test",
        writableRoots: [],
        protectedPaths: [],
      }),
    ).toThrow()
  })
})

describe("sandbox.SandboxRuntime wrapper generation (cross-platform)", () => {
  test("generateWrapper defaults writableRoots to [workspace/.synergy] when not provided", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")
    const workspace = "/tmp/test-project"

    const wrapper = SandboxRuntime.generateWrapper({
      platform: "macos",
      workspace,
      protectedPaths: [],
    })

    const profileStr = wrapper.profileRules.join("\n")
    // The generated profile must include workspace path for writes
    expect(profileStr).toContain(workspace)
  })

  test("generateWrapper preserves writable root order", () => {
    const { SandboxRuntime } = require("../../src/sandbox/runtime")

    const roots = ["/tmp/a", "/tmp/b", "/tmp/c"]
    const wrapper = SandboxRuntime.generateWrapper({
      platform: "macos",
      workspace: "/tmp/ws",
      writableRoots: roots,
      protectedPaths: [],
    })

    const profileStr = wrapper.profileRules.join("\n")
    // Roots should appear in the profile in the order they were given
    const aIdx = profileStr.indexOf(roots[0])
    const bIdx = profileStr.indexOf(roots[1])
    const cIdx = profileStr.indexOf(roots[2])
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(-1)
    expect(cIdx).toBeGreaterThan(-1)
    expect(aIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(cIdx)
  })
})
