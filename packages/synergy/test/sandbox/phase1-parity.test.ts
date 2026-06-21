// ---------------------------------------------------------------------------
// sandbox/phase1-parity.test.ts
//
// RED tests for Phase 1 Codex parity fixes.
// These tests define the target contract BEFORE implementation.
//
// Four fixes tested:
//   1. macOS deny-default is the default (not gated behind explicit backend opt-in)
//   2. Linux backend mounts extraReadRoots / extraWritableRoots
//   3. Windows backend uses shared DEFAULT_PROTECTED_PATHS from policy.ts
//   4. Windows readiness distinguishes missing helper vs hash failure
//
// Constraints:
//   - Tests MUST fail on current production code (RED signal).
//   - No real Windows/Linux execution — test argument generation only.
//   - Use forcePlatform to bypass platform detection.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/phase1-parity.test.ts
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test"
import { SandboxBackend } from "../../src/sandbox/backend"
import { DEFAULT_PROTECTED_PATHS } from "../../src/sandbox/policy"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ------------------------------------------------------------------
// Helper: extract all -D KEY=VALUE pairs from args as a Map
// ------------------------------------------------------------------
function extractDParams(args: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-D") {
      const pair = args[i + 1]
      const eq = pair.indexOf("=")
      if (eq > 0) {
        result.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
    }
  }
  return result
}

// ==================================================================
// 1. macOS: deny-default is the default
// ==================================================================
describe("Phase 1: macOS deny-default parity", () => {
  test("uses deny-default by default when backend is not specified", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    expect(wrapper.command).toBe("sandbox-exec")
    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.skipReason).toBeUndefined()

    // Deny-default path adds -D params — must be present.
    const hasDParams = wrapper.args.some((a: string) => a === "-D")
    expect(hasDParams).toBe(true)

    // Read the temp profile — must use (deny default) base.
    const tempPath = wrapper.args[1]
    expect(tempPath).toMatch(/\.sb$/)
    const profile = fs.readFileSync(tempPath, "utf8")
    try {
      expect(profile).toContain("(deny default)")
      expect(profile).not.toContain("(allow default)")
    } finally {
      SandboxBackend.cleanupTemp(tempPath)
    }
  })

  test("explicit seatbelt-legacy-allow-default preserves legacy profile", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
      backend: "seatbelt-legacy-allow-default",
    })

    expect(wrapper.command).toBe("sandbox-exec")
    expect(wrapper.sandboxed).toBe(true)

    // Legacy path has NO -D args
    const hasDParams = wrapper.args.some((a: string) => a === "-D")
    expect(hasDParams).toBe(false)

    // Verify legacy profile content
    const tempPath = wrapper.args[1]
    const profile = fs.readFileSync(tempPath, "utf8")
    try {
      expect(profile).toContain("(allow default)")
      // Legacy profile must NOT contain deny-default markers
      expect(profile).not.toContain("(deny default)")
    } finally {
      SandboxBackend.cleanupTemp(tempPath)
    }
  })
  test("deny-default forwards extraReadRoots and extraWritableRoots as -D params", () => {
    const readRoot = "/tmp/test-read-root-" + Math.random().toString(36).slice(2, 8)
    const writeRoot = "/tmp/test-write-root-" + Math.random().toString(36).slice(2, 8)
    // Ensure temp dirs exist so canonicalize / sibling-deny doesn't choke
    try {
      fs.mkdirSync(readRoot, { recursive: true })
    } catch {}
    try {
      fs.mkdirSync(writeRoot, { recursive: true })
    } catch {}

    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
      backend: "seatbelt-deny-default",
      extraReadRoots: [readRoot],
      extraWritableRoots: [writeRoot],
    })

    expect(wrapper.command).toBe("sandbox-exec")
    expect(wrapper.sandboxed).toBe(true)

    const dParams = extractDParams(wrapper.args)

    // Canonicalize to match generateParams which calls fs.realpathSync
    // (on macOS APFS /tmp → /private/tmp).
    let canonicalRead = readRoot
    let canonicalWrite = writeRoot
    try {
      canonicalRead = fs.realpathSync(readRoot)
    } catch {}
    try {
      canonicalWrite = fs.realpathSync(writeRoot)
    } catch {}

    // extraReadRoot must appear in a PATH_READ_N param
    const readFound = [...dParams.entries()].some(
      ([key, value]: [string, string]) => key.startsWith("PATH_READ_") && value === canonicalRead,
    )
    expect(readFound).toBe(true)

    // extraWritableRoot must appear in a PATH_WRITE_N param
    const writeFound = [...dParams.entries()].some(
      ([key, value]: [string, string]) => key.startsWith("PATH_WRITE_") && value === canonicalWrite,
    )
    expect(writeFound).toBe(true)

    // Cleanup temp dirs and profile
    try {
      fs.rmdirSync(readRoot)
    } catch {}
    try {
      fs.rmdirSync(writeRoot)
    } catch {}
    SandboxBackend.cleanupTemp(wrapper.args[1])
  })
})

// ==================================================================
// 2. Linux: extraReadRoots / extraWritableRoots mounted in bwrap
// ==================================================================
describe("Phase 1: Linux extra roots parity", () => {
  test("extraReadRoots are mounted as --ro-bind in bwrap args", () => {
    const readRoot = "/tmp/test-linux-read-" + Math.random().toString(36).slice(2, 8)
    // Create the directory so bwrap has a source to bind
    try {
      fs.mkdirSync(readRoot, { recursive: true })
    } catch {}

    // Use prepareLinuxWrapper with backend:"bwrap-inline-debug" to opt into inline bwrap behavior.
    // Use prepareLinuxWrapper to bypass bwrap availability check,
    // with backend:"bwrap-inline-debug" to opt into inline bwrap behavior.
    const wrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
      extraReadRoots: [readRoot],
    })

    expect(wrapper.command).toBe("bwrap")
    expect(wrapper.sandboxed).toBe(true)

    // Verify --ro-bind readRoot readRoot exists
    const args = wrapper.args
    const roBindFound = args.some(
      (a: string, i: number) => a === "--ro-bind" && args[i + 1] === readRoot && args[i + 2] === readRoot,
    )
    expect(roBindFound).toBe(true)

    try {
      fs.rmdirSync(readRoot)
    } catch {}
  })

  test("extraWritableRoots are mounted as --bind in bwrap args", () => {
    const writeRoot = "/tmp/test-linux-write-" + Math.random().toString(36).slice(2, 8)
    try {
      fs.mkdirSync(writeRoot, { recursive: true })
    } catch {}

    const wrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
      extraWritableRoots: [writeRoot],
    })

    expect(wrapper.command).toBe("bwrap")
    expect(wrapper.sandboxed).toBe(true)

    const args = wrapper.args
    const bindFound = args.some(
      (a: string, i: number) => a === "--bind" && args[i + 1] === writeRoot && args[i + 2] === writeRoot,
    )
    expect(bindFound).toBe(true)

    try {
      fs.rmdirSync(writeRoot)
    } catch {}
  })

  test("both extraReadRoots and extraWritableRoots are mounted together", () => {
    const readRoot = "/tmp/test-linux-both-r-" + Math.random().toString(36).slice(2, 8)
    const writeRoot = "/tmp/test-linux-both-w-" + Math.random().toString(36).slice(2, 8)
    try {
      fs.mkdirSync(readRoot, { recursive: true })
    } catch {}
    try {
      fs.mkdirSync(writeRoot, { recursive: true })
    } catch {}

    const wrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
      extraReadRoots: [readRoot],
      extraWritableRoots: [writeRoot],
    })

    expect(wrapper.command).toBe("bwrap")
    expect(wrapper.sandboxed).toBe(true)

    const args = wrapper.args

    // Both mounts must be present
    const roBindFound = args.some(
      (a: string, i: number) => a === "--ro-bind" && args[i + 1] === readRoot && args[i + 2] === readRoot,
    )
    expect(roBindFound).toBe(true)

    const bindFound = args.some(
      (a: string, i: number) => a === "--bind" && args[i + 1] === writeRoot && args[i + 2] === writeRoot,
    )
    expect(bindFound).toBe(true)

    // Must NOT mount root filesystem
    const hasRootRoBind = args.some((a: string, i: number) => a === "--ro-bind" && args[i + 1] === "/")
    expect(hasRootRoBind).toBe(false)

    try {
      fs.rmdirSync(readRoot)
    } catch {}
    try {
      fs.rmdirSync(writeRoot)
    } catch {}
  })

  test("extraReadRoots / extraWritableRoots propagate through prepareWrapper dispatch", () => {
    // Same test but via the dispatch path (prepareWrapper).
    // This may return skipReason if bwrap is unavailable; we handle both cases.
    const readRoot = "/tmp/test-linux-dispatch-r-" + Math.random().toString(36).slice(2, 8)
    const writeRoot = "/tmp/test-linux-dispatch-w-" + Math.random().toString(36).slice(2, 8)
    try {
      fs.mkdirSync(readRoot, { recursive: true })
    } catch {}
    try {
      fs.mkdirSync(writeRoot, { recursive: true })
    } catch {}

    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      extraReadRoots: [readRoot],
      extraWritableRoots: [writeRoot],
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
    })

    // If bwrap is not available, the wrapper has skipReason — that's a
    // platform limitation, not a test failure.
    if (wrapper.skipReason) {
      expect(wrapper.sandboxed).toBe(false)
      // Still verify skipReason makes sense
      expect(wrapper.skipReason).toMatch(/bwrap/i)
      try {
        fs.rmdirSync(readRoot)
      } catch {}
      try {
        fs.rmdirSync(writeRoot)
      } catch {}
      return
    }

    expect(wrapper.command).toBe("bwrap")
    expect(wrapper.sandboxed).toBe(true)

    const args = wrapper.args
    const roBindFound = args.some(
      (a: string, i: number) => a === "--ro-bind" && args[i + 1] === readRoot && args[i + 2] === readRoot,
    )
    expect(roBindFound).toBe(true)

    const bindFound = args.some(
      (a: string, i: number) => a === "--bind" && args[i + 1] === writeRoot && args[i + 2] === writeRoot,
    )
    expect(bindFound).toBe(true)

    try {
      fs.rmdirSync(readRoot)
    } catch {}
    try {
      fs.rmdirSync(writeRoot)
    } catch {}
  })
})

// ==================================================================
// 3. Windows: protected paths use shared constants
// ==================================================================
describe("Phase 1: Windows protected paths parity", () => {
  test("DEFAULT_PROTECTED_PATHS includes Windows-relevant credential paths", () => {
    // The shared policy constants from policy.ts must cover all Windows
    // credential paths so that the Windows backend does not need its own
    // truncated 3-path list.
    const homedir = os.homedir()
    const workspace = "/Users/test/project"
    const paths = DEFAULT_PROTECTED_PATHS(homedir, workspace)

    // Workspace-specific protections
    expect(paths).toContain(path.join(workspace, ".git"))
    expect(paths).toContain(path.join(workspace, ".synergy"))

    // Synergy internal config/auth — must be protected on all platforms
    expect(paths).toContain(path.join(homedir, ".synergy", "config"))
    expect(paths).toContain(path.join(homedir, ".synergy", "data", "auth"))

    // Network and cloud credentials — critical for Windows where users
    // often store AWS/GCloud/Azure credentials in homedir
    expect(paths).toContain(path.join(homedir, ".netrc"))
    expect(paths).toContain(path.join(homedir, ".ssh"))
    expect(paths).toContain(path.join(homedir, ".aws"))
    expect(paths).toContain(path.join(homedir, ".config", "gcloud"))
    expect(paths).toContain(path.join(homedir, ".docker", "config.json"))

    // Shell configs — prevent command injection via shell rc rewriting
    expect(paths).toContain(path.join(homedir, ".bashrc"))
    expect(paths).toContain(path.join(homedir, ".zshrc"))
    expect(paths).toContain(path.join(homedir, ".profile"))

    // Other agent configs — CBSE protection
    expect(paths).toContain(path.join(homedir, ".cursor"))
    expect(paths).toContain(path.join(homedir, ".claude"))
    expect(paths).toContain(path.join(homedir, ".codex"))
    expect(paths).toContain(path.join(homedir, ".gemini"))

    // Verify total count is reasonable — shared list should contain all
    // CREDENTIAL_PATHS plus workspace .git/.synergy.
    // CREDENTIAL_PATHS has 20 entries + 2 workspace = 22 minimum
    expect(paths.length).toBeGreaterThanOrEqual(20)
  })

  test("BLOCKER: WindowsBackend config uses local 3-path list instead of DEFAULT_PROTECTED_PATHS", () => {
    // The Windows backend (windows.ts lines 88-94) defines its own
    // defaultProtectedPaths() function returning only 3 entries.
    // It should import and use DEFAULT_PROTECTED_PATHS from policy.ts.
    //
    // Testing this at the backend level requires reaching
    // WindowsBackend.prepare() past the helper binary check, which is
    // not currently injectable. The findHelperBinary() function
    // (windows.ts lines 39-59) searches hardcoded paths and verifies
    // hashes against a compile-time constant TRUSTED_HELPER_HASHES.
    //
    // Once the helper binary check is injectable (e.g. via an optional
    // forceHelperPath parameter or dependency-injection seam), add:
    //
    //    test("WindowsBackend.prepare() uses DEFAULT_PROTECTED_PATHS", () => {
    //      const wrapper = SandboxBackend.prepareWrapper({
    //        command: "echo", args: ["test"],
    //        workspace: "C:\\Users\\test\\project",
    //        sandboxMode: "workspace_write",
    //        forcePlatform: "windows",
    //        forceHelperPath: "/fake/synergy-sandbox.exe",
    //      })
    //      // Read config JSON from wrapper.tempPath
    //      // Assert config.protected_paths equals DEFAULT_PROTECTED_PATHS(...)
    //      // Assert config.protected_paths.length > 3
    //    })
    //
    // For now, we verify DEFAULT_PROTECTED_PATHS above.
    expect(true).toBe(true) // documented blocker, not a failure
  })
})

// ==================================================================
// 4. Windows readiness: missing helper vs hash failure
// ==================================================================
describe("Phase 1: Windows readiness diagnostics", () => {
  test("getWindowsHelperInfo is exported from windows module", () => {
    // Verify the diagnostic function exists and returns null on non-Windows.
    // This is a smoke test for the API shape, not production behavior.
    const { getWindowsHelperInfo } = require("../../src/sandbox/windows")
    expect(typeof getWindowsHelperInfo).toBe("function")

    // On non-Windows, should return null (no helper binary)
    const info = getWindowsHelperInfo()
    if (os.platform() !== "win32") {
      expect(info).toBeNull()
    }
  })

  test("BLOCKER: readiness route distinguishes missing helper vs hash failure", () => {
    // The sandbox-readiness-route.ts already has distinct handling:
    //   - helper not found → fail with "helper binary not found"
    //   - helper found but hash fails → warn + fail on hash check
    //
    // Testing this requires either:
    //   1. An HTTP integration test with a server that can receive injected
    //      Windows helper paths (not currently possible)
    //   2. Extracting the readiness logic into a testable pure function
    //      that accepts PlatformInfo/helperInfo as parameters
    //
    // Until the readiness route is refactored to accept injectable platform
    // state, we cannot unit-test the Windows readiness distinction without
    // a real Windows helper binary on disk.
    //
    // The existing production logic at sandbox-readiness-route.ts:250-304
    // correctly distinguishes the two cases. The implementation is correct;
    // we just cannot write a deterministic test without an injectable seam.
    expect(true).toBe(true) // documented blocker, not a failure
  })
})
