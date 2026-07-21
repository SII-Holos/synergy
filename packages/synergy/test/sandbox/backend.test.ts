import { describe, test, expect } from "bun:test"
import { SandboxBackend } from "../../src/sandbox/backend"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

function printCommand(text: string) {
  return {
    command: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(text)})`],
  }
}

// ---------------------------------------------------------------------------
// sandbox/backend.test.ts
//
// Tests for the real sandbox backend — macOS sandbox-exec wrapper,
// Seatbelt profile generation, temp file lifecycle, and cross-platform
// sandbox invocation.
//
// These tests encode the sandbox backend contract.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/backend.test.ts
// ---------------------------------------------------------------------------
// ------------------------------------------------------------------
// 1. SandboxBackend command wrapping — argv-based, not shell string
// ------------------------------------------------------------------
describe("SandboxBackend command wrapping (macOS)", () => {
  test("wraps command using argv array, not shell string", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello", "world"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    // The wrapper must produce the command and arguments as an argv array,
    // NOT a joined shell string. Critical for safe execution.
    expect(wrapper.command).toBe("sandbox-exec")
    expect(Array.isArray(wrapper.args)).toBe(true)

    // Deny-default path adds -D KEY=VALUE args before the command.
    // Use dynamic lookup instead of fixed positions.
    const cmdIndex = wrapper.args.indexOf("echo")
    expect(cmdIndex).toBeGreaterThan(0) // command must be present, not at start

    // The args MUST contain: "-f", <temp path>, "echo", "hello", "world"
    expect(wrapper.args[0]).toBe("-f")
    expect(wrapper.args[cmdIndex]).toBe("echo")
    expect(wrapper.args[cmdIndex + 1]).toBe("hello")
    expect(wrapper.args[cmdIndex + 2]).toBe("world")
  })

  test("wraps command with no extra args correctly", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "ls",
      args: [],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    expect(wrapper.command).toBe("sandbox-exec")
    // Deny-default adds -D params before command. Count varies.
    // Verify "ls" is the last arg.
    expect(wrapper.args[wrapper.args.length - 1]).toBe("ls")
  })

  test("profile temp file path is embedded in args at position 1", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "git",
      args: ["status"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    // Position 1 (after -f) must be a .sb temp file path
    expect(wrapper.args[1]).toMatch(/\.sb$/)
    // Should be in a temp directory
    expect(wrapper.args[1]).toContain("synergy-sandbox-")
  })
})

// ------------------------------------------------------------------
// 2. Temp profile file lifecycle — created by parent, cleaned in finally
// ------------------------------------------------------------------
describe("SandboxBackend temp profile lifecycle", () => {
  test("profile file is written to a temp location", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "node",
      args: ["-e", "console.log(1)"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })

    const tempPath = wrapper.args[1]
    expect(tempPath).toBeDefined()

    // The temp file must be writable by the current process
    // (We can check this on supported platforms)
    expect(() => fs.accessSync(tempPath, fs.constants.W_OK)).not.toThrow()
  })

  test("temp profile is cleaned up after execution", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "true",
      args: [],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
    })

    const tempPath = wrapper.args[1]

    // Execute the sandbox — must be skipped on platforms without sandbox-exec
    if (wrapper.skipReason) {
      // Test still passes — we're testing the contract, not the binary
      return
    }

    // After execution, the temp file must be removed
    SandboxBackend.execute(wrapper)

    // The parent process must clean up the temp file in a finally block
    expect(() => fs.accessSync(tempPath)).toThrow()
    // Specific error: ENOENT
    try {
      fs.accessSync(tempPath)
    } catch (e: any) {
      expect(e.code).toBe("ENOENT")
    }
  })

  test("temp profile is cleaned up even if sandbox command fails", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "nonexistent_command_xyz_123",
      args: [],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
    })

    const tempPath = wrapper.args[1]

    if (wrapper.skipReason) return

    // Even if the sandbox command itself fails, the temp file cleanup
    // must run (finally block, not conditional)
    try {
      SandboxBackend.execute(wrapper)
    } catch (_) {
      // command expected to fail
    }

    try {
      fs.accessSync(tempPath)
      // File exists when it should have been cleaned up
      expect(true).toBe(false) // force fail if we get here
    } catch (e: any) {
      expect(e.code).toBe("ENOENT")
    }
  })
})

// ------------------------------------------------------------------
// 3. Seatbelt profile generation — NO global allow file-read*
// ------------------------------------------------------------------
describe("SandboxBackend Seatbelt profile generation", () => {
  test("generated profile does NOT contain global (allow file-read*)", () => {
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib", "/System/Library"],
      writableRoots: ["/Users/test/project"],
      protectedPaths: [path.join("/Users/test/project", ".git"), os.homedir() + "/.synergy/config"],
    })

    const profileStr = profile.join("\n")

    // CRITICAL: must NOT contain a global unrestricted file-read rule
    // that applies to user data directories
    expect(profileStr).not.toMatch(/\(allow\s+file-read\*\)/)
    expect(profileStr).not.toMatch(/\(allow\s+file-read\*\s*\)/)

    // All file-read* rules must be scoped to specific subpaths or exact literals.
    const fileReadRules = profileStr.match(/\(allow\s+file-read\*[^)]*\)/g) ?? []
    for (const rule of fileReadRules) {
      expect(rule).toMatch(/subpath|literal/)
    }
  })

  test("profile explicitly allows runtime read roots", () => {
    const runtimeReadRoots = ["/usr/lib", "/System/Library/Frameworks"]

    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots,
      writableRoots: [],
      protectedPaths: [],
    })

    const profileStr = profile.join("\n")

    for (const root of runtimeReadRoots) {
      // Each runtime read root must have an explicit (allow file-read* (subpath "..."))
      expect(profileStr).toContain(root)
    }
  })

  test("profile explicitly allows active workspace data read/write", () => {
    const workspace = "/Users/test/synergy-control-profile"
    const writableRoots = [workspace, path.posix.join(workspace, ".synergy", "tmp")]

    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots,
      protectedPaths: [],
    })

    const profileStr = profile.join("\n")

    for (const root of writableRoots) {
      // Workspace data roots must have explicit file-read* + file-write*
      expect(profileStr).toContain(root)
      // The rule must grant both read and write to this root
      expect(profileStr).toMatch(
        new RegExp(`\\(allow\\s+file-read\\*\\s+file-write\\*\\s+\\(subpath\\s+"${root.replace(/\//g, "\\/")}"\\)\\)`),
      )
    }
  })

  test("workspace_write profile includes controlled tmp write access", () => {
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: ["/Users/test/project"],
      protectedPaths: [],
    })

    const profileStr = profile.join("\n")

    // workspace_write mode must include a controlled tmp directory for
    // temporary writes (not a global /tmp allow)
    expect(profileStr).toMatch(/file-write\*.*\.synergy.*tmp/)
  })

  test("read_only profile only grants read access, no write", () => {
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "read_only",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: [],
      protectedPaths: [],
    })

    const profileStr = profile.join("\n")

    // read_only profile must not contain any file-write* permission
    expect(profileStr).not.toMatch(/file-write\*/)
  })

  test("profile includes (version 1) header", () => {
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: [],
      writableRoots: [],
      protectedPaths: [],
    })

    expect(profile[0]).toBe("(version 1)")
  })

  test("profile uses (allow default) as the base policy", () => {
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: [],
      writableRoots: [],
      protectedPaths: [],
    })

    // The base policy must be allow default — macOS sandbox-exec
    // requires this base; security is provided by explicit
    // (deny file-write*) rules on protected paths placed after
    // write-allow rules (last-match-wins semantics).
    const profileStr = profile.join("\n")
    expect(profileStr).toContain("(allow default)")
  })

  test("profile denies broad user data roots before re-allowing active workspace", () => {
    const workspace = "/Users/test/synergy-control-profile"
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: [workspace],
      protectedPaths: [],
      dataDenyRoots: ["/Users/test"],
    })

    const profileStr = profile.join("\n")
    const denyHome = profile.findIndex(
      (line: string) => line.includes("deny file-read* file-write*") && line.includes("/Users/test"),
    )
    const allowWorkspace = profile.findIndex(
      (line: string) => line.includes("allow file-read*") && line.includes(workspace),
    )

    expect(profileStr).toContain('(deny file-read* file-write* (subpath "/Users/test"))')
    expect(profileStr).toContain(`(allow file-read* (subpath "${workspace}") (literal "${workspace}"))`)
    expect(denyHome).toBeGreaterThan(-1)
    expect(allowWorkspace).toBeGreaterThan(denyHome)
  })

  test("profile re-allows user runtime roots after broad home deny", () => {
    const runtimeRoot = "/Users/test/.gitconfig"
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: [runtimeRoot],
      writableRoots: ["/Users/test/project"],
      protectedPaths: [],
      dataDenyRoots: ["/Users/test"],
    })

    const denyHome = profile.findIndex(
      (line: string) => line.includes("deny file-read* file-write*") && line.includes("/Users/test"),
    )
    const allowRuntime = profile.findIndex(
      (line: string) => line.includes("allow file-read*") && line.includes(runtimeRoot),
    )

    expect(denyHome).toBeGreaterThan(-1)
    expect(allowRuntime).toBeGreaterThan(denyHome)
  })

  test("prepareWrapper adds approved external roots as one-call sandbox exceptions", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "cat",
      args: ["/Users/test/Downloads/input.txt"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
      backend: "seatbelt-legacy-allow-default",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: ["/Users/test/project"],
      extraReadRoots: ["/Users/test/Downloads/input.txt"],
      extraWritableRoots: ["/Users/test/Downloads/input.txt"],
    })

    const profilePath = wrapper.args[1]
    const profile = fs.readFileSync(profilePath, "utf8")
    try {
      expect(profile).toContain('(allow file-read* (subpath "/Users/test/Downloads/input.txt")')
      expect(profile).toContain('(allow file-read* file-write* (subpath "/Users/test/Downloads/input.txt"))')
    } finally {
      SandboxBackend.cleanupTemp(profilePath)
    }
  })

  test("profile allows exact runtime files as literals", () => {
    const runtimeFile = "/Users/test/.gitconfig"
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: [runtimeFile],
      writableRoots: ["/Users/test/project"],
      protectedPaths: [],
      dataDenyRoots: ["/Users/test"],
    })

    expect(profile.join("\n")).toContain(`(allow file-read* (subpath "${runtimeFile}") (literal "${runtimeFile}"))`)
  })

  test("profile allows literal parent directories for cwd traversal", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "pwd",
      args: [],
      workspace: "/Users/test/projects/app",
      executionCwd: "/Users/test/projects/app/packages/core",
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
      backend: "seatbelt-legacy-allow-default",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: ["/Users/test/projects/app"],
      dataDenyRoots: ["/Users/test"],
    })

    const profilePath = wrapper.args[1]
    const profile = fs.readFileSync(profilePath, "utf8")
    try {
      expect(profile).toContain('(allow file-read* (literal "/Users"))')
      expect(profile).toContain('(allow file-read* (literal "/Users/test"))')
      expect(profile).toContain('(allow file-read* (literal "/Users/test/projects"))')
      expect(profile).toContain('(allow file-read* (literal "/Users/test/projects/app"))')
      expect(profile).toContain('(allow file-read* (literal "/Users/test/projects/app/packages"))')
      expect(profile).toContain('(allow file-read* (literal "/Users/test/projects/app/packages/core"))')
    } finally {
      SandboxBackend.cleanupTemp(profilePath)
    }
  })
})

// ------------------------------------------------------------------
// 4. Protected path deny rules
// ------------------------------------------------------------------
describe("SandboxBackend protected path deny rules", () => {
  test("protected .git directory is denied writes", () => {
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: ["/Users/test/project"],
      protectedPaths: [path.join("/Users/test/project", ".git")],
    })

    const profileStr = profile.join("\n")

    expect(profileStr).toMatch(/\(deny\s+file-write\*.*\.git/)
  })

  test("protected .synergy config is denied writes", () => {
    const protectedPath = os.homedir() + "/.synergy/config"

    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: [],
      protectedPaths: [protectedPath],
    })

    const profileStr = profile.join("\n")

    expect(profileStr).toContain(protectedPath)
    expect(profileStr).toMatch(/\(deny\s+file-write\*.*\.synergy\/config/)
  })

  test("protected auth secrets path is denied writes", () => {
    const authPath = os.homedir() + "/.synergy/data/auth/api-key.json"

    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: [],
      protectedPaths: [authPath],
    })

    const profileStr = profile.join("\n")

    expect(profileStr).toContain("auth/api-key")
    expect(profileStr).toMatch(/\(deny\s+file-write\*/)
  })

  test("protected paths take precedence over writable roots", () => {
    const workspace = "/Users/test/project"

    // .git is both under the writable root AND in protected paths
    // Protected path deny must come AFTER the writable root allow
    // so it takes precedence (seatbelt last-match-wins or explicit deny wins)
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: [workspace],
      protectedPaths: [path.join(workspace, ".git")],
    })

    const profileStr = profile.join("\n")

    const allowIndex = profileStr.indexOf(`(allow file-read* file-write* (subpath "${workspace}"))`)
    const denyIndex = profileStr.indexOf(`(deny file-write* (subpath "${path.join(workspace, ".git")}"))`)

    // Deny rule must appear AFTER allow rule so it takes precedence
    expect(allowIndex).toBeGreaterThan(-1)
    expect(denyIndex).toBeGreaterThan(-1)
    expect(denyIndex).toBeGreaterThan(allowIndex)
  })
})

// ------------------------------------------------------------------
// 5. Cross-platform sandbox support
// ------------------------------------------------------------------
describe("SandboxBackend cross-platform support", () => {
  test("reports availability correctly on macOS", () => {
    const info = SandboxBackend.platformInfo()

    expect(info).toBeDefined()
    expect(typeof info.platform).toBe("string")
    expect(typeof info.available).toBe("boolean")
    expect(info.backend).toBeDefined()

    if (os.platform() === "darwin") {
      expect(info.platform).toBe("macos")
      expect(info.backend).toBe("sandbox-exec")
    }
  })

  test("Linux backend uses bwrap, not sandbox-exec", () => {
    // The backend must have a method to generate a bwrap wrapper for Linux
    const wrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib", "/lib"],
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
    })

    // bwrap command, not sandbox-exec
    expect(wrapper.command).toBe("bwrap")
    expect(Array.isArray(wrapper.args)).toBe(true)
  })

  test("bwrap does NOT --ro-bind / / (whole root filesystem)", () => {
    const wrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/home/user/project",
      sandboxMode: "workspace_write",
      runtimeReadRoots: ["/usr/lib", "/lib"],
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
    })

    // Critical: must NOT bind-mount the entire root filesystem.
    // Individual --ro-bind mounts (e.g. --ro-bind /usr/lib /usr/lib) are fine.
    const hasRootBind = wrapper.args.some((a: string, i: number) => a === "--ro-bind" && wrapper.args[i + 1] === "/")
    expect(hasRootBind).toBe(false)
  })

  test("bwrap only mounts runtime roots and active workspace", () => {
    const runtimeReadRoots = ["/usr/lib", "/lib"]
    const workspace = "/home/user/project"

    const wrapper = SandboxBackend.prepareLinuxWrapper({
      command: "echo",
      args: ["hello"],
      workspace,
      sandboxMode: "workspace_write",
      runtimeReadRoots,
      forcePlatform: "linux",
      backend: "bwrap-inline-debug",
    })

    // Each runtime read root must be individually bind-mounted
    for (const root of runtimeReadRoots) {
      expect(wrapper.args).toContain(root)
    }
    // Active workspace must be explicitly mounted
    expect(wrapper.args).toContain(workspace)
  })

  test("Windows platform reports as sandbox-capable", () => {
    const supported = SandboxBackend.isPlatformSupported("win32")
    expect(supported).toBe(true)
  })
})

// ------------------------------------------------------------------
// 6. Sandbox unavailable fallback
// ------------------------------------------------------------------
describe("SandboxBackend unavailable fallback", () => {
  test("when unavailable, prepareWrapper returns skipReason", () => {
    // Force unavailable
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/tmp/test",
      sandboxMode: "workspace_write",
      forcePlatform: "unsupported_os",
    })

    expect(wrapper.skipReason).toBeDefined()
    expect(typeof wrapper.skipReason).toBe("string")
    expect(wrapper.skipReason!.length).toBeGreaterThan(0)
  })

  test("when fallback is deny, execute rejects with clear error", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["test"],
      workspace: "/tmp/test",
      sandboxMode: "workspace_write",
      forcePlatform: "unsupported_os",
    })

    // When sandbox is unavailable and fallback is deny, execution must fail
    expect(() => SandboxBackend.execute(wrapper, { fallbackPolicy: "deny" })).toThrow()
  })

  test("when fallback is warn, execute runs without sandbox", () => {
    const command = printCommand("hello")
    const wrapper = SandboxBackend.prepareWrapper({
      command: command.command,
      args: command.args,
      workspace: "/tmp/test",
      sandboxMode: "workspace_write",
      forcePlatform: "unsupported_os",
    })

    // With fallback "warn", execution should proceed unsandboxed
    // (on an unsupported platform, the actual command runs without sandbox)
    expect(() => SandboxBackend.execute(wrapper, { fallbackPolicy: "warn" })).not.toThrow()
  })

  test("when fallback is allow, execute runs without sandbox silently", () => {
    const command = printCommand("hello")
    const wrapper = SandboxBackend.prepareWrapper({
      command: command.command,
      args: command.args,
      workspace: "/tmp/test",
      sandboxMode: "workspace_write",
      forcePlatform: "unsupported_os",
    })

    // With fallback "allow", execution proceeds without error
    expect(() => SandboxBackend.execute(wrapper, { fallbackPolicy: "allow" })).not.toThrow()
  })
})

// ------------------------------------------------------------------
// 7. Sandbox mode policy mapping
// ------------------------------------------------------------------
describe("SandboxBackend mode to seatbelt policy mapping", () => {
  test("none mode produces no sandbox wrapper", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/Users/test/project",
      sandboxMode: "none",
    })

    // When sandbox mode is "none", no wrapper should be applied
    expect(wrapper.command).toBe("echo")
    expect(wrapper.args).toEqual(["hello"])
    expect(wrapper.sandboxed).toBe(false)
  })

  test("workspace_write mode produces sandbox wrapper", () => {
    // This test only asserts command shape on platforms where sandbox is available
    if (os.platform() !== "darwin") return
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["hello"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
    })

    if (!wrapper.skipReason) {
      expect(wrapper.sandboxed).toBe(true)
      expect(wrapper.command).toBe("sandbox-exec")
    }
  })

  test("read_only mode produces sandbox wrapper without write permissions", () => {
    const profile = SandboxBackend.generateSeatbeltProfile({
      workspace: "/Users/test/project",
      sandboxMode: "read_only",
      runtimeReadRoots: ["/usr/lib"],
      writableRoots: [],
      protectedPaths: [],
    })

    // read_only profile must not grant write access
    const profileStr = profile.join("\n")
    expect(profileStr).not.toMatch(/file-write\*/)
  })
})

// ------------------------------------------------------------------
// 8. OS execution tests — skipped unless backend available
// ------------------------------------------------------------------
describe("SandboxBackend OS execution (skipped unless available)", () => {
  test("execute succeeds with simple command in sandbox", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "true",
      args: [],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      backend: "seatbelt-legacy-allow-default",
    })

    if (wrapper.skipReason) {
      // Skipping real OS test on this platform
      return
    }

    const result = SandboxBackend.execute(wrapper)
    expect(result.exitCode).toBe(0)
  })
  test("execute captures stdout in sandbox", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "echo",
      args: ["sandbox-test-output"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
      backend: "seatbelt-legacy-allow-default",
    })

    if (wrapper.skipReason) return

    const result = SandboxBackend.execute(wrapper)
    expect(result.stdout).toContain("sandbox-test-output")
  })

  test("sandbox prevents writes to protected system path", () => {
    const wrapper = SandboxBackend.prepareWrapper({
      command: "touch",
      args: ["/etc/should-fail"],
      workspace: "/Users/test/project",
      sandboxMode: "workspace_write",
    })

    if (wrapper.skipReason) return

    const result = SandboxBackend.execute(wrapper)
    // Sandbox should prevent writing to /etc — command exits non-zero
    expect(result.exitCode).not.toBe(0)
  })
})
