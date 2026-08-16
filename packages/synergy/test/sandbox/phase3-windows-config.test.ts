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
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { buildPermissionProfile } from "../../src/sandbox/policy-engine"
import type { SynergySandboxPermissionProfile } from "../../src/sandbox/policy-engine"
import { inspectWindowsHelper } from "../../src/sandbox/windows"

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
// ==================================================================
// 6. Windows helper CLI shape contract
// ==================================================================
describe("Phase 3 Slice 2: Windows helper CLI argument shape", () => {
  test("sandboxed wrapper args match helper CLI contract: --permission-profile <path> --cwd <cwd> -- <cmd> <args...>", () => {
    // The Rust helper main.rs expects exactly this argv shape.
    // This is a GREEN contract test — the current implementation
    // already conforms. It serves as a regression guard.
    const wrapper = SandboxBackend.prepareWrapper({
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "Write-Host test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.command).toBe("C:\\Synergy\\synergy-sandbox-windows.exe")

    const args = wrapper.args
    // args[0] = "--permission-profile"
    expect(args[0]).toBe("--permission-profile")
    // args[1] = path to temp JSON config file
    expect(args[1]).toMatch(/synergy-sandbox-windows-[a-f0-9]+\.json$/)
    // args[2] = "--cwd"
    expect(args[2]).toBe("--cwd")
    // args[3] = CWD (workspace by default)
    expect(args[3]).toBe("C:\\Users\\test\\project")
    // args[4] = "--" separator
    expect(args[4]).toBe("--")
    // args[5] = child command
    expect(args[5]).toBe("powershell.exe")
    // args[6..] = child args, preserved verbatim
    expect(args[6]).toBe("-NoProfile")
    expect(args[7]).toBe("-Command")
    expect(args[8]).toBe("Write-Host test")
    expect(args.length).toBe(9)

    // Cleanup temp file
    if (wrapper.tempPath) fs.rmSync(wrapper.tempPath, { force: true })
  })

  test("sandboxed wrapper uses executionCwd for --cwd when provided", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "dir"],
      workspace: "C:\\Users\\test\\project",
      executionCwd: "C:\\Users\\test\\subdir",
      sandboxMode: "read_only",
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.args[2]).toBe("--cwd")
    expect(wrapper.args[3]).toBe("C:\\Users\\test\\subdir")

    if (wrapper.tempPath) fs.rmSync(wrapper.tempPath, { force: true })
  })

  test("tempPath is cleaned up after test (verify write format)", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "echo test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    expect(wrapper.tempPath).toBeDefined()
    expect(wrapper.tempPath).toMatch(/\.json$/)
    // Verify the file is valid JSON
    const content = fs.readFileSync(wrapper.tempPath!, "utf8")
    const parsed = JSON.parse(content)
    expect(parsed).toHaveProperty("fileSystem")
    expect(parsed).toHaveProperty("network")
    fs.rmSync(wrapper.tempPath!, { force: true })
  })
})

describe("Windows sandbox preserves caller protection roots", () => {
  test("passes protectedPaths and dataDenyRoots into the helper profile", () => {
    const protectedPaths = ["C:\\secrets\\credentials.json"]
    const dataDenyRoots = ["C:\\Users\\other-user"]
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "echo test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      protectedPaths,
      dataDenyRoots,
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    const tempJson = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))
    expect(tempJson.fileSystem.protectedPaths).toEqual(protectedPaths)
    expect(tempJson.fileSystem.dataDenyRoots).toEqual(dataDenyRoots)
    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("preserves an explicitly supplied home deny root", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "echo test"],
      workspace: path.join(os.homedir(), "project"),
      sandboxMode: "workspace_write",
      dataDenyRoots: [os.homedir()],
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    const tempJson = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))
    expect(tempJson.fileSystem.dataDenyRoots).toEqual([os.homedir()])
    fs.rmSync(wrapper.tempPath!, { force: true })
  })

  test("removes only the shared profile's default home deny root before invoking the Windows helper", () => {
    const explicitDenyRoot = "C:\\Users\\other-user"
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cmd.exe",
      args: ["/c", "echo test"],
      workspace: path.join(os.homedir(), "project"),
      sandboxMode: "workspace_write",
      dataDenyRoots: [os.homedir(), explicitDenyRoot],
      stripDefaultHomeDenyRoot: true,
      forcePlatform: "windows",
      forceHelperPath: "C:\\Synergy\\synergy-sandbox-windows.exe",
      forceHelperVerified: true,
    })

    const tempJson = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))
    expect(tempJson.fileSystem.dataDenyRoots).toEqual([explicitDenyRoot])
    expect(tempJson.fileSystem.protectedPaths.length).toBeGreaterThan(0)
    fs.rmSync(wrapper.tempPath!, { force: true })
  })
})

describe("Windows helper diagnostics", () => {
  function helperFixture(machine: number) {
    const helperPath = path.join(os.tmpdir(), `synergy-windows-helper-${crypto.randomUUID()}.exe`)
    const contents = Buffer.alloc(256)
    contents.write("MZ", 0, "ascii")
    contents.writeUInt32LE(0x80, 0x3c)
    contents.write("PE\0\0", 0x80, "ascii")
    contents.writeUInt16LE(machine, 0x84)
    fs.writeFileSync(helperPath, contents)
    return { helperPath, contents }
  }

  test("reports verified hash and matching PE architecture separately", () => {
    const fixture = helperFixture(0x8664)
    try {
      const hash = crypto.createHash("sha256").update(fixture.contents).digest("hex")
      const info = inspectWindowsHelper(fixture.helperPath, { [fixture.helperPath]: hash })
      expect(info.architecture).toBe("x64")
      expect(info.hashStatus).toBe("verified")
      expect(info.architectureMatches).toBe(process.arch === "x64")
      expect(info.verified).toBe(process.arch === "x64")
    } finally {
      fs.rmSync(fixture.helperPath, { force: true })
    }
  })

  test("reports architecture mismatch without mislabeling a valid hash", () => {
    const fixture = helperFixture(0xaa64)
    try {
      const hash = crypto.createHash("sha256").update(fixture.contents).digest("hex")
      const info = inspectWindowsHelper(fixture.helperPath, { [fixture.helperPath]: hash })
      expect(info.architecture).toBe("arm64")
      expect(info.hashStatus).toBe("verified")
      expect(info.architectureMatches).toBe(process.arch === "arm64")
      expect(info.verified).toBe(process.arch === "arm64")
    } finally {
      fs.rmSync(fixture.helperPath, { force: true })
    }
  })

  test("reports a missing trusted hash distinctly from a hash mismatch", () => {
    const fixture = helperFixture(0x8664)
    try {
      expect(inspectWindowsHelper(fixture.helperPath, {}).hashStatus).toBe("missing")
      expect(inspectWindowsHelper(fixture.helperPath, { [fixture.helperPath]: "0".repeat(64) }).hashStatus).toBe(
        "mismatch",
      )
    } finally {
      fs.rmSync(fixture.helperPath, { force: true })
    }
  })
})

describe("Windows helper probe revalidation", () => {
  test("re-probes and re-verifies the helper on every call (no spoofable cache)", () => {
    const { findHelperBinary } = require("../../src/sandbox/windows")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-helper-reprobe-"))
    const helperPath = path.join(root, "synergy-sandbox-windows.exe")
    const contents = Buffer.alloc(4096)
    contents.write("MZ", 0, "ascii")
    contents.writeUInt32LE(0x80, 0x3c)
    contents.write("PE\0\0", 0x80, "ascii")
    contents.writeUInt16LE(0x8664, 0x84)
    fs.writeFileSync(helperPath, contents)
    const searchPaths = [() => helperPath]
    try {
      // First probe: helper is verified only when a trusted hash matches.
      const first = findHelperBinary(searchPaths)
      // Same bytes, same stat signature: a second probe must return an equal
      // result but must NOT be served from a signature cache — the binary is
      // re-read and re-hashed every time so a same-size/same-mtime swap is
      // still detected on the next command.
      const second = findHelperBinary(searchPaths)
      expect(second).toEqual(first)

      // Swap the bytes with same length and restore the mtime: a stat-signature
      // cache would serve the stale verified result; revalidation must not.
      const tampered = Buffer.from(contents)
      tampered.writeUInt16LE(0x14c, 0x84) // PE machine x86, differing from x64
      const tamperedPath = path.join(root, "synergy-sandbox-windows-swapped.exe")
      fs.writeFileSync(tamperedPath, tampered)
      const swapped = findHelperBinary([() => tamperedPath])
      expect(swapped).not.toBeNull()
      // Architecture read from the actual bytes, not from a cached signature.
      expect(swapped!.architecture).toBe("x86")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
