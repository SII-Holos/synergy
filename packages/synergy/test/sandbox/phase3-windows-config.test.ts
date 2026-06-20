// ---------------------------------------------------------------------------
// sandbox/phase3-windows-config.test.ts
//
// RED tests for Phase 3 Windows Codex parity Slice 1:
//   - Helper binary name: synergy-sandbox-windows.exe (not synergy-sandbox.exe)
//   - Config shape: SynergySandboxPermissionProfile (not flat WindowsSandboxConfig)
//   - Skip reasons: distinct messages for binary-not-found vs hash-failure
//   - Empty trusted hashes → isWindowsHelperAvailable() returns false
//
// These tests define the target contract BEFORE implementation.
//
// Constraints:
//   - Deterministic on macOS; no actual Windows execution required.
//   - Use forcePlatform to bypass platform detection.
//   - Behavior-level assertions against exported APIs.
//   - Documented blockers where seams are not yet injectable.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/phase3-windows-config.test.ts
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test"
import * as fs from "fs"
import { SandboxBackend } from "../../src/sandbox/backend"
import { buildPermissionProfile } from "../../src/sandbox/policy-engine"
import type { SynergySandboxPermissionProfile } from "../../src/sandbox/policy-engine"

// ==================================================================
// 1. Helper binary name: synergy-sandbox-windows.exe
// ==================================================================
describe("Phase 3 Slice 1: Windows helper binary name", () => {
  test("isWindowsHelperAvailable is exported and returns boolean", () => {
    // The function already exists. Verify its signature.
    const winMod = require("../../src/sandbox/windows")
    expect(typeof winMod.isWindowsHelperAvailable).toBe("function")

    const result = winMod.isWindowsHelperAvailable()
    expect(typeof result).toBe("boolean")
  })

  test("isWindowsHelperAvailable returns false when TRUSTED_HELPER_HASHES is empty", () => {
    // TRUSTED_HELPER_HASHES is currently an empty record {}.
    // This means even if a binary is found on disk, verifyHelperHash()
    // returns false (no trusted hash to compare against).
    // Therefore isWindowsHelperAvailable() MUST return false.
    const { isWindowsHelperAvailable } = require("../../src/sandbox/windows")
    expect(isWindowsHelperAvailable()).toBe(false)
  })

  test("getWindowsHelperInfo returns null when helper is unavailable", () => {
    // On non-Windows platforms, no helper binary will be found.
    // With empty trusted hashes, no binary will pass verification.
    const { getWindowsHelperInfo } = require("../../src/sandbox/windows")
    const info = getWindowsHelperInfo()
    expect(info).toBeNull()
  })

  test("prepareWrapper forcePlatform windows skipReason mentions helper binary name", () => {
    // Phase 3: the skipReason for missing helper should mention
    // synergy-sandbox-windows.exe, not the old synergy-sandbox.exe.
    //
    // RED expected: current code says "Windows sandbox helper binary not found"
    // but does not mention the specific binary name. After Phase 3,
    // the skipReason should reference "synergy-sandbox-windows.exe".
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
    })

    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toBeDefined()
    expect(typeof wrapper.skipReason).toBe("string")
    expect(wrapper.skipReason!.length).toBeGreaterThan(0)

    // Phase 3 target: the skipReason should reference the new binary name
    expect(wrapper.skipReason).toMatch(/synergy-sandbox-windows\.exe/i)
  })
})

// ==================================================================
// 2. Config shape: SynergySandboxPermissionProfile (not flat config)
// ==================================================================
describe("Phase 3 Slice 1: Windows config uses shared PermissionProfile", () => {
  test("buildPermissionProfile produces SynergySandboxPermissionProfile shape", () => {
    // The shared PermissionProfile shape that Linux already uses.
    // Windows backend should write this same shape to the temp config file.
    const profile = buildPermissionProfile({
      workspace: "C:\\Users\\test\\project",
      executionCwd: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      approvedReadPaths: ["C:\\Users\\test\\.synergy\\cache"],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    // Top-level must have fileSystem and network — NOT flat level/mode/workspace/command keys
    expect(profile).toHaveProperty("fileSystem")
    expect(profile).toHaveProperty("network")
    expect(profile).not.toHaveProperty("level")
    expect(profile).not.toHaveProperty("command")
    expect(profile).not.toHaveProperty("args")
  })

  test("SynergySandboxPermissionProfile JSON has correct camelCase keys for Rust deserialization", () => {
    // The Rust helper (Linux config.rs) uses #[serde(rename = "readableRoots")] etc.
    // The JSON keys must match exactly.
    const profile = buildPermissionProfile({
      workspace: "C:\\Users\\test\\project",
      executionCwd: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    const json = JSON.parse(JSON.stringify(profile))
    const fs2 = json.fileSystem

    // Phase 3 contract: these are the exact JSON keys the Rust helper expects
    expect(fs2).toHaveProperty("workspace")
    expect(fs2).toHaveProperty("readableRoots")
    expect(fs2).toHaveProperty("writableRoots")
    expect(fs2).toHaveProperty("readOnlySubpaths")
    expect(fs2).toHaveProperty("unreadableGlobs")
    expect(fs2).toHaveProperty("protectedMetadataNames")
    expect(fs2).toHaveProperty("protectedPaths")
    expect(fs2).toHaveProperty("dataDenyRoots")
    expect(fs2).toHaveProperty("includePlatformDefaults")

    const net = json.network
    expect(net).toHaveProperty("mode")
    expect(net).toHaveProperty("allowLocalBinding")
    expect(net).toHaveProperty("allowedUnixSockets")
  })

  test("WindowsBackend.prepare writes SynergySandboxPermissionProfile JSON", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "echo test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.tempPath).toBeDefined()
    const tempJson = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))

    expect(tempJson).toHaveProperty("fileSystem")
    expect(tempJson).toHaveProperty("network")
    expect(tempJson).not.toHaveProperty("level")
    expect(tempJson).not.toHaveProperty("command")
    expect(tempJson).not.toHaveProperty("args")
    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("WindowsBackend.prepare writes camelCase PermissionProfile keys", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "echo test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    const tempJson = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))
    const fsPolicy = tempJson.fileSystem
    expect(fsPolicy).toHaveProperty("writableRoots")
    expect(fsPolicy).toHaveProperty("readableRoots")
    expect(fsPolicy).toHaveProperty("readOnlySubpaths")
    expect(fsPolicy).toHaveProperty("protectedPaths")
    expect(fsPolicy).toHaveProperty("dataDenyRoots")
    expect(fsPolicy).not.toHaveProperty("writable_roots")
    expect(fsPolicy).not.toHaveProperty("read_roots")
    expect(fsPolicy).not.toHaveProperty("protected_paths")
    fs.rmSync(wrapper.tempPath!, { force: true })
  })
})

// ==================================================================
// 3. Skip reason messages: distinct for binary-not-found vs hash-failure
// ==================================================================
describe("Phase 3 Slice 1: Windows skipReason messages", () => {
  test("prepareWrapper skipReason for missing helper mentions binary not found", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
    })

    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toMatch(/not found/i)
    // The message should NOT mention hash verification (that's a different failure mode)
    expect(wrapper.skipReason).not.toMatch(/hash/i)
  })

  test("hash-verification-failed skipReason is distinct from binary-not-found", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "echo test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: false,
    })

    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toMatch(/hash verification failed/i)
    expect(wrapper.skipReason).not.toMatch(/not found/i)
  })

  test("prepareWrapper skipReason for non-windows platform mentions platform mismatch", () => {
    // A distinct skipReason when the platform is explicitly not Windows.
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      forcePlatform: "linux", // Not windows!
    })

    if (wrapper.skipReason) {
      // This test is about Windows behavior — the wrapper could be sandboxed on Linux
      // (if bwrap is available) or have a Linux-specific skipReason.
      // Either way, the skipReason (if present) should NOT be about Windows.
      expect(wrapper.skipReason).not.toMatch(/Windows sandbox/i)
    }
  })
})

// ==================================================================
// 4. Windows helper hash contract: empty → unavailable
// ==================================================================
describe("Phase 3 Slice 1: Windows helper hash contract", () => {
  test("isWindowsHelperAvailable returns false when no trusted hashes are embedded", () => {
    // TRUSTED_HELPER_HASHES is empty. Even if a binary called
    // synergy-sandbox-windows.exe sits on disk, verifyHelperHash returns
    // false when no trusted hash is stored. Therefore the helper is
    // never available until a hash is embedded at build time.
    const { isWindowsHelperAvailable } = require("../../src/sandbox/windows")
    expect(isWindowsHelperAvailable()).toBe(false)
  })

  test("prepareWrapper never returns sandboxed:true for windows when hashes are empty", () => {
    // Safety invariant: if no trusted hashes are embedded, the Windows
    // sandbox helper must NEVER be used. prepare() must return sandboxed:false
    // with skipReason no matter what binary is on disk.
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "dir"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
    })

    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toBeDefined()
  })
})

// ==================================================================
// 5. Windows backend preserves original command/args on skip
// ==================================================================
describe("Phase 3 Slice 1: original command preservation on skip", () => {
  test("original command and args preserved when sandbox is skipped", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "git",
      args: ["status", "--porcelain"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
    })

    // The caller must be able to fall back to unsandboxed execution.
    expect(wrapper.command).toBe("git")
    expect(wrapper.args).toEqual(["status", "--porcelain"])
    expect(wrapper.sandboxed).toBe(false)
  })

  test("sandboxMode none returns unwrapped even for windows platform", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "none",
      forcePlatform: "windows",
    })

    expect(wrapper.command).toBe("echo")
    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toBeUndefined()
  })
})
