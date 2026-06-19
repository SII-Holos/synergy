import { SandboxBackend } from "../../src/sandbox/backend"
import * as fs from "fs"
import * as os from "os"

// ---------------------------------------------------------------------------
// sandbox/dispatch.test.ts
//
// Tests for the refactored sandbox dispatch layer:
// - Cross-platform routing (macOS, Linux, Windows)
// - Fallback semantics (skipReason + deny/warn/allow)
// - platformInfo, isPlatformSupported
// - Temp cleanup lifecycle
// - Backward compat for prepareLinuxWrapper
//
// These tests verify the dispatch contract after the backend.ts refactor
// (impl-backend-refactor + phase2-linux-reconnect).
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/dispatch.test.ts
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// 1. isPlatformSupported — Phase 2: all main platforms recognized
// ------------------------------------------------------------------
describe("isPlatformSupported", () => {
  test("win32 → true (Phase 2: Windows platform recognized)", () => {
    expect(SandboxBackend.isPlatformSupported("win32")).toBe(true)
  })

  test("windows → true (Phase 2: Windows platform recognized)", () => {
    expect(SandboxBackend.isPlatformSupported("windows")).toBe(true)
  })

  test("darwin → true", () => {
    expect(SandboxBackend.isPlatformSupported("darwin")).toBe(true)
  })

  test("macos → true", () => {
    expect(SandboxBackend.isPlatformSupported("macos")).toBe(true)
  })

  test("linux → true", () => {
    expect(SandboxBackend.isPlatformSupported("linux")).toBe(true)
  })

  test("freebsd → false", () => {
    expect(SandboxBackend.isPlatformSupported("freebsd")).toBe(false)
  })

  test("sunos → false", () => {
    expect(SandboxBackend.isPlatformSupported("sunos")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 2. platformInfo() on macOS
// ------------------------------------------------------------------
describe("platformInfo on macOS", () => {
  test("returns platform=macos with sandbox-exec backend when running on darwin", () => {
    if (os.platform() !== "darwin") {
      return // Skip on non-macOS
    }

    const info = SandboxBackend.platformInfo()
    expect(info.platform).toBe("macos")
    expect(info.available).toBe(true)
    expect(info.backend).toBe("sandbox-exec")
  })
})

// ------------------------------------------------------------------
// 3. prepareWrapper() dispatch routing
// ------------------------------------------------------------------
describe("prepareWrapper dispatch routing", () => {
  test("sandboxMode none returns unwrapped command with sandboxed=false", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/Users/test/project",
      sandboxMode: "none",
    })

    expect(wrapper.command).toBe("echo")
    expect(wrapper.args).toEqual(["hello"])
    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toBeUndefined()
    expect(wrapper.tempPath).toBeUndefined()
  })

  test("forcePlatform macos dispatches to sandbox-exec with temp profile", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["dispatch-test"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    // macOS dispatch produces sandbox-exec
    expect(wrapper.command).toBe("sandbox-exec")
    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.skipReason).toBeUndefined()

    // Args structure: ["-f", <tempPath>, command, ...args]
    expect(wrapper.args[0]).toBe("-f")
    expect(wrapper.args[2]).toBe("echo")
    expect(wrapper.args[3]).toBe("dispatch-test")

    // Temp profile file exists and has .sb suffix
    const tempPath = wrapper.args[1]
    expect(tempPath).toMatch(/\.sb$/)
    expect(wrapper.tempPath).toBe(tempPath)
    expect(() => fs.accessSync(tempPath, fs.constants.W_OK)).not.toThrow()

    // Clean up
    SandboxBackend.cleanupTemp(tempPath)
  })

  test("forcePlatform windows returns skipReason when helper not installed (Phase 3)", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "C:\\Users\\test\\project",
      sandboxMode: "workspace_write",
      forcePlatform: "windows",
    })

    // Phase 3: Windows backend attempts to find the helper binary.
    // On non-Windows machines, it will not be found, so skipReason
    // describes the helper not being installed.
    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toBeDefined()
    expect(wrapper.skipReason).toMatch(/helper/i)
    expect(wrapper.command).toBe("echo")
    expect(wrapper.args).toEqual(["test"])
  })

  test("forcePlatform freebsd returns skipReason for unsupported platform", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/tmp/test",
      sandboxMode: "workspace_write",
      forcePlatform: "freebsd",
    })

    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.skipReason).toBeDefined()
    expect(wrapper.skipReason).toContain("freebsd")
    expect(wrapper.command).toBe("echo")
    expect(wrapper.args).toEqual(["test"])
  })
})

// ------------------------------------------------------------------
// 4. prepareLinuxWrapper() backward compat
// ------------------------------------------------------------------
describe("prepareLinuxWrapper backward compat", () => {
  test("forcePlatform linux produces bwrap command with correct args structure", () => {
    const workspace = "/home/user/project"
    const runtimeReadRoots = ["/usr/lib", "/lib"]

    const wrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["hello"],
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots,
      forcePlatform: "linux",
    })

    expect(wrapper.command).toBe("bwrap")
    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.skipReason).toBeUndefined()

    // Must not contain --ro-bind of /
    const hasRootRoBind = wrapper.args.some((a: string, i: number) => a === "--ro-bind" && wrapper.args[i + 1] === "/")
    expect(hasRootRoBind).toBe(false)

    // Each runtime read root is individually bind-mounted
    for (const root of runtimeReadRoots) {
      expect(wrapper.args).toContain(root)
    }

    // Workspace is explicitly mounted
    expect(wrapper.args).toContain(workspace)

    // Controlled tmp is bind-mounted (bind tmpDir /tmp)
    expect(wrapper.args).toContain("/tmp")

    // Command separator
    const sepIdx = wrapper.args.indexOf("--")
    expect(sepIdx).toBeGreaterThan(0)

    // Command and args after separator
    expect(wrapper.args[sepIdx + 1]).toBe("echo")
    expect(wrapper.args[sepIdx + 2]).toBe("hello")
  })
})

// ------------------------------------------------------------------
// 5. execute() fallback — skipReason handling
// ------------------------------------------------------------------
describe("execute fallback", () => {
  test("skipReason with fallbackPolicy deny throws", () => {
    const wrapper = {
      command: "echo",
      args: ["hello"],
      sandboxed: false,
      skipReason: "Sandbox not available on platform freebsd",
    }

    expect(() => SandboxBackend.execute(wrapper, { fallbackPolicy: "deny" })).toThrow(/Sandbox execution denied/)
    expect(() => SandboxBackend.execute(wrapper, { fallbackPolicy: "deny" })).toThrow(/freebsd/)
  })

  test("skipReason with fallbackPolicy warn spawns directly (unsandboxed)", () => {
    const wrapper = {
      command: "echo",
      args: ["warn-fallback-test"],
      sandboxed: false,
      skipReason: "Sandbox not available",
    }

    const result = SandboxBackend.execute(wrapper, { fallbackPolicy: "warn" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("warn-fallback-test")
  })

  test("skipReason with fallbackPolicy allow spawns directly (unsandboxed)", () => {
    const wrapper = {
      command: "echo",
      args: ["allow-fallback-test"],
      sandboxed: false,
      skipReason: "Sandbox not available",
    }

    const result = SandboxBackend.execute(wrapper, { fallbackPolicy: "allow" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("allow-fallback-test")
  })

  test("default fallback policy is warn (unsandboxed)", () => {
    const wrapper = {
      command: "echo",
      args: ["default-warn-test"],
      sandboxed: false,
      skipReason: "Sandbox not available",
    }

    // No fallbackPolicy specified → defaults to "warn"
    const result = SandboxBackend.execute(wrapper)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("default-warn-test")
  })
})

// ------------------------------------------------------------------
// 6. execute() sandboxed — temp cleanup lifecycle
// ------------------------------------------------------------------
describe("execute sandboxed temp cleanup", () => {
  test("sandboxed=true runs wrapper and cleans up temp on success", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "true",
      args: [],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    const tempPath = wrapper.tempPath
    expect(tempPath).toBeDefined()
    expect(wrapper.sandboxed).toBe(true)

    // Execute sandboxed command
    const result = SandboxBackend.execute(wrapper)
    expect(result.exitCode).toBe(0)

    // Temp profile must be cleaned up
    try {
      fs.accessSync(tempPath!)
      // File still exists — fail the test
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.code).toBe("ENOENT")
    }
  })

  test("sandboxed=true cleans up temp even on command failure", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "nonexistent_command_xyz_dispatch_123",
      args: [],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    const tempPath = wrapper.tempPath
    expect(tempPath).toBeDefined()
    expect(wrapper.sandboxed).toBe(true)

    // Execute sandboxed command — expected to fail
    try {
      SandboxBackend.execute(wrapper)
    } catch (_) {
      // Command failure expected
    }

    // Temp profile must be cleaned up even though command failed
    try {
      fs.accessSync(tempPath!)
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.code).toBe("ENOENT")
    }
  })

  test("sandboxed=false with skipReason does not create temp profile", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/tmp/test",
      sandboxMode: "workspace_write",
      forcePlatform: "freebsd",
    })

    expect(wrapper.sandboxed).toBe(false)
    expect(wrapper.tempPath).toBeUndefined()
  })
})

// ------------------------------------------------------------------
// 7. prepareWrapper Linux dispatch (dispatch → LinuxBackend)
// ------------------------------------------------------------------
describe("prepareWrapper Linux dispatch", () => {
  test("forcePlatform linux dispatches to LinuxBackend and returns bwrap wrapper", () => {
    const workspace = "/home/user/project"
    const runtimeReadRoots = ["/usr/lib", "/lib64"]

    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["linux-dispatch-test"],
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots,
      forcePlatform: "linux",
    })

    // Dispatch must route to LinuxBackend
    expect(wrapper.command).toBe("bwrap")
    expect(wrapper.sandboxed).toBe(true)
    expect(wrapper.skipReason).toBeUndefined()

    // Verify arg structure
    const args = wrapper.args

    // Runtime read roots are individually mounted
    for (const root of runtimeReadRoots) {
      expect(args).toContain(root)
    }

    // Workspace is mounted
    expect(args).toContain(workspace)

    // Controlled tmp is bind-mounted
    expect(args).toContain("/tmp")

    // Separator
    const sepIdx = args.indexOf("--")
    expect(sepIdx).toBeGreaterThan(0)

    // Command + args after separator
    expect(args[sepIdx + 1]).toBe("echo")
    expect(args[sepIdx + 2]).toBe("linux-dispatch-test")

    // No --ro-bind of /
    const hasRootRoBind = args.some((a: string, i: number) => a === "--ro-bind" && args[i + 1] === "/")
    expect(hasRootRoBind).toBe(false)
  })

  test("prepareWrapper Linux matches prepareLinuxWrapper output shape", () => {
    const workspace = "/home/user/project"
    const runtimeReadRoots = ["/usr/lib"]

    // Via dispatch
    const dispatchWrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots,
      forcePlatform: "linux",
    })

    // Via backward compat API
    const compatWrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["test"],
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots,
      forcePlatform: "linux",
    })

    // Both should produce identical output
    expect(dispatchWrapper.command).toBe(compatWrapper.command)
    expect(dispatchWrapper.sandboxed).toBe(compatWrapper.sandboxed)
    expect(dispatchWrapper.args).toEqual(compatWrapper.args)
  })
})
