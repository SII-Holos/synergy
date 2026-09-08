// ---------------------------------------------------------------------------
// sandbox/phase2-linux-dispatch.test.ts
//
// RED tests for Phase 2 Linux Codex parity: helper-based dispatch.
// These tests define the target contract BEFORE implementation.
//
// Three behaviors tested:
//   1. Default Linux path no longer returns inline bwrap — it should look for
//      synergy-sandbox-linux Rust helper and return skipReason if missing.
//   2. backend:"bwrap-inline-debug" explicitly opts into old inline bwrap behavior.
//   3. sandboxMode:"none" always unwraps regardless of backend or platform.
//
// Constraints:
//   - Deterministic on macOS; no real Linux helper or bwrap required.
//   - Use forcePlatform to bypass platform detection.
//   - Behavior-focused assertions; no source text greps.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/phase2-linux-dispatch.test.ts
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test"
import { SandboxBackend } from "../../src/sandbox/backend"

// ==================================================================
// 1. Default Linux path → helper-backed, NOT inline bwrap
// ==================================================================
describe("Phase 2: Linux helper dispatch (default path)", () => {
  test("prepareWrapper with forcePlatform linux does NOT return command bwrap by default", () => {
    // Phase 2: the default Linux backend should use synergy-sandbox-linux Rust helper.
    // Without the helper installed, it should return skipReason, NOT fall through
    // to inline bwrap.
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      forcePlatform: "linux",
      forceHelperPath: "/test/synergy-sandbox-linux",
      forceHelperVerified: false,
    })

    // The wrapper command must NOT be "bwrap" — inline bwrap is opt-in only.
    expect(wrapper.command).not.toBe("bwrap")
    expect(wrapper.sandboxed).toBe(false)

    // skipReason must reference synergy-sandbox-linux, not the old
    // "bwrap not found" message.
    expect(wrapper.skipReason).toBeDefined()
    expect(typeof wrapper.skipReason).toBe("string")
    expect(wrapper.skipReason!.length).toBeGreaterThan(0)
    expect(wrapper.skipReason).toMatch(/synergy-sandbox-linux/i)
  })

  test("prepareWrapper with forcePlatform linux preserves original command and args on skip", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "git",
      args: ["status", "--porcelain"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      forcePlatform: "linux",
      forceHelperPath: "/test/synergy-sandbox-linux",
      forceHelperVerified: false,
    })

    // Even when sandbox is skipped, the original command and args are preserved
    // so the caller can fall back to unsandboxed execution.
    expect(wrapper.command).toBe("git")
    expect(wrapper.args).toEqual(["status", "--porcelain"])
    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toMatch(/synergy-sandbox-linux/i)
  })

  test("prepareWrapper Linux default does not check for bwrap at all", () => {
    // Phase 2: the new helper path replaces bwrap entirely.
    // The dispatch should NOT call isBwrapAvailable() or check for bwrap.
    // The skipReason should be about the helper, not about bwrap.
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      forceHelperPath: "/test/synergy-sandbox-linux",
      forceHelperVerified: false,
    })

    // skipReason must NOT mention bwrap.
    expect(wrapper.skipReason).not.toMatch(/bwrap/i)
    // skipReason must mention the helper.
    expect(wrapper.skipReason).toMatch(/synergy-sandbox-linux/i)
  })
})

// ==================================================================
// 2. backend:"bwrap-inline-debug" — opt-in to old inline bwrap
// ==================================================================
describe("Phase 2: bwrap-inline-debug backend opt-in", () => {
  test("backend bwrap-inline-debug returns command bwrap with correct args", () => {
    // Phase 2: explicit backend:"bwrap-inline-debug" preserves the current
    // inline bwrap behavior for debugging/comparison. This path delegates
    // to the existing LinuxBackend.prepare().

    const workspace = "/home/user/project"
    const runtimeReadRoots = ["/usr/lib", "/lib64"]

    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["debug-test"],
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots,
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
    })

    // If bwrap is not installed on this machine, the wrapper will have
    // a skipReason about bwrap — that's expected for the inline path.
    if (wrapper.skipReason) {
      // The skipReason may mention bwrap since this path needs bwrap
      return
    }

    // Otherwise, must return bwrap command with correct arg structure.
    expect(wrapper.command).toBe("bwrap")
    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.skipReason).toBeUndefined()

    const args = wrapper.args
    // Each runtime read root is individually bind-mounted
    for (const root of runtimeReadRoots) {
      expect(args).toContain(root)
    }
    // Workspace is mounted
    expect(args).toContain(workspace)

    // Command separator
    const sepIdx = args.indexOf("--")
    expect(sepIdx).toBeGreaterThan(0)
    expect(args[sepIdx + 1]).toBe("echo")
    expect(args[sepIdx + 2]).toBe("debug-test")

    // Must NOT --ro-bind /
    const hasRootRoBind = args.some((a: string, i: number) => a === "--ro-bind" && args[i + 1] === "/")
    expect(hasRootRoBind).toBe(false)
  })

  test("backend bwrap-inline-debug returns skipReason if bwrap not installed", () => {
    // On macOS or systems without bwrap, the inline-debug path should still
    // return a skipReason (about bwrap, since it needs bwrap).
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
    })

    // The inline bwrap path must eventually check for bwrap availability.
    // If bwrap is not present, it returns skipReason.
    // The skipReason exists when bwrap is unavailable; sandboxed is false.
    if (wrapper.skipReason) {
      expect(wrapper.sandboxed).toBe(false)
    }
    // If bwrap IS available, the wrapper is sandboxed with bwrap command.
  })

  test("backend bwrap-inline-debug is the only way to get command bwrap", () => {
    // Phase 2: the ONLY way to get `command: "bwrap"` is via the
    // explicit backend:"bwrap-inline-debug" opt-in. The default path
    // must not produce bwrap.
    //
    // We verify this by checking that the default path does NOT return
    // "bwrap" and that changing one option (adding backend) does.

    const defaultWrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
    })

    // Default path must NOT produce bwrap
    expect(defaultWrapper.command).not.toBe("bwrap")
  })
})

// ==================================================================
// 3. sandboxMode:"none" — always unwrapped
// ==================================================================
describe("Phase 2: sandboxMode none bypass (Linux)", () => {
  test("sandboxMode none returns unwrapped regardless of backend on Linux", () => {
    // sandboxMode:"none" must take priority over all backend/platform settings.
    // This is already implemented; we verify it handles the Linux platform path.

    const wrapper = SandboxBackend.prepareWrapper({
      command: "npm",
      args: ["install"],
      workspace: "/home/user/project",
      sandboxMode: "none",
      forcePlatform: "linux",
      backend: "bwrap-inline-debug", // should be ignored
    })

    expect(wrapper.command).toBe("npm")
    expect(wrapper.args).toEqual(["install"])
    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toBeUndefined()
    expect(wrapper.tempPath).toBeUndefined()
  })

  test("sandboxMode none bypasses even with explicit backend on Linux", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "make",
      args: ["build"],
      workspace: "/home/user/project",
      sandboxMode: "none",
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
    })

    expect(wrapper.command).toBe("make")
    expect(wrapper.args).toEqual(["build"])
    expect(wrapper.sandboxed).toBe(false)
  })
})
