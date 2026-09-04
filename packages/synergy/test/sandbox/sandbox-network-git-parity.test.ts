import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildPermissionProfile } from "../../src/sandbox/policy-engine"
import {
  DEFAULT_USER_RUNTIME_READ_ROOTS,
  defaultRuntimeReadRoots,
  gitProtectedSubpaths,
  macosPlatformReadRoots,
} from "../../src/sandbox/policy"
import { MacBackend } from "../../src/sandbox/macos"
import { LinuxBackend } from "../../src/sandbox/linux"

const WORKSPACE = "/Users/test/synergy-control-profile"

function profile(overrides: Partial<Parameters<typeof buildPermissionProfile>[0]> = {}) {
  return buildPermissionProfile({
    workspace: WORKSPACE,
    executionCwd: WORKSPACE,
    sandboxMode: "workspace_write",
    approvedReadPaths: [],
    approvedWritePaths: [],
    approvedNetwork: false,
    approvedUnixSockets: [],
    ...overrides,
  })
}

describe("sandbox network parity (PR #1308 follow-up)", () => {
  test("approvedNetwork=true compiles to full network mode", () => {
    expect(profile({ approvedNetwork: true }).network.mode).toBe("full")
  })

  test("approvedNetwork=false compiles to restricted network mode", () => {
    expect(profile({ approvedNetwork: false }).network.mode).toBe("restricted")
  })

  test("macOS deny-default wrapper allows network* only when networkMode is full", () => {
    const full = MacBackend.prepare({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace: WORKSPACE,
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
      networkMode: "full",
    })
    const restricted = MacBackend.prepare({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace: WORKSPACE,
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
      networkMode: "restricted",
    })
    expect(full.sandboxed).toBe(true)
    expect(restricted.sandboxed).toBe(true)
    const fullProfile = fs.readFileSync(full.tempPath!, "utf8")
    const restrictedProfile = fs.readFileSync(restricted.tempPath!, "utf8")
    expect(fullProfile).toContain("(allow network*)")
    expect(restrictedProfile).not.toContain("(allow network*)")
    MacBackend.cleanupTemp(full.tempPath!)
    MacBackend.cleanupTemp(restricted.tempPath!)
  })

  test("macOS deny-default defaults to restricted when networkMode is absent", () => {
    const wrapper = MacBackend.prepare({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace: WORKSPACE,
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })
    const sbpl = fs.readFileSync(wrapper.tempPath!, "utf8")
    expect(sbpl).not.toContain("(allow network*)")
    MacBackend.cleanupTemp(wrapper.tempPath!)
  })

  test("linux helper profile threads networkMode", () => {
    const wrapper = LinuxBackend.prepare({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace: WORKSPACE,
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      forceHelperPath: "/bin/true",
      forceHelperVerified: true,
      networkMode: "full",
    })
    expect(wrapper.sandboxed).toBe(true)
    const helperProfile = JSON.parse(fs.readFileSync(wrapper.tempPath!, "utf8"))
    expect(helperProfile.network.mode).toBe("full")
    fs.unlinkSync(wrapper.tempPath!)
  })

  test("linux helper profile binds /etc read-only only when networkMode is full", () => {
    const full = LinuxBackend.prepare({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace: WORKSPACE,
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      forceHelperPath: "/bin/true",
      forceHelperVerified: true,
      networkMode: "full",
    })
    const restricted = LinuxBackend.prepare({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace: WORKSPACE,
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      forceHelperPath: "/bin/true",
      forceHelperVerified: true,
      networkMode: "restricted",
    })
    expect(full.sandboxed).toBe(true)
    expect(restricted.sandboxed).toBe(true)
    const fullProfile = JSON.parse(fs.readFileSync(full.tempPath!, "utf8"))
    const restrictedProfile = JSON.parse(fs.readFileSync(restricted.tempPath!, "utf8"))
    // /etc always exists on Linux; the remaining paths are existence-filtered.
    expect(fullProfile.fileSystem.readableRoots).toContain("/etc")
    expect(restrictedProfile.fileSystem.readableRoots).not.toContain("/etc")
    fs.unlinkSync(full.tempPath!)
    fs.unlinkSync(restricted.tempPath!)
  })
})

describe("sandbox git write parity (PR #1308 follow-up)", () => {
  test("readOnlySubpaths protects .git hooks/config, not the whole .git directory", () => {
    const p = profile()
    expect(p.fileSystem.readOnlySubpaths).toContain(`${WORKSPACE}/.git/hooks`)
    expect(p.fileSystem.readOnlySubpaths).toContain(`${WORKSPACE}/.git/config`)
    expect(p.fileSystem.readOnlySubpaths).not.toContain(`${WORKSPACE}/.git`)
  })

  test("protectedMetadataNames keeps .agents/.codex blanket denies and drops the .git blanket", () => {
    const names = profile().fileSystem.protectedMetadataNames
    expect(names).toContain(".agents")
    expect(names).toContain(".codex")
    expect(names).not.toContain(".git")
  })

  test("gitProtectedSubpaths expands per writable root", () => {
    expect(gitProtectedSubpaths("/ws")).toEqual(["/ws/.git/hooks", "/ws/.git/config"])
  })

  test("extra writable roots get the same hooks/config expansion", () => {
    const extra = "/Users/test/other-project"
    const p = profile({ approvedWritePaths: [extra] })
    expect(p.fileSystem.readOnlySubpaths).toContain(`${extra}/.git/hooks`)
    expect(p.fileSystem.readOnlySubpaths).toContain(`${extra}/.git/config`)
    expect(p.fileSystem.readOnlySubpaths).not.toContain(`${extra}/.git`)
  })
})

describe("sandbox read-root parity (PR #1308 follow-up)", () => {
  test("macOS platform read roots cover developer toolchains", () => {
    const roots = macosPlatformReadRoots()
    expect(roots).toContain("/opt/homebrew")
    expect(roots).toContain("/usr/local")
    expect(roots).toContain("/etc")
    expect(roots).toContain("/Library/Developer/CommandLineTools")
    expect(roots).not.toContain("/tmp")
    expect(roots).not.toContain("/private/tmp")
  })

  test("runtime user roots under the homedir are not defeated by sibling denies", () => {
    if (process.platform !== "darwin") return
    const wrapper = MacBackend.prepare({
      command: "/bin/sh",
      args: ["-c", "true"],
      workspace: WORKSPACE,
      sandboxMode: "workspace_write",
      forcePlatform: "macos",
    })
    const sbpl = fs.readFileSync(wrapper.tempPath!, "utf8")
    MacBackend.cleanupTemp(wrapper.tempPath!)
    const homedir = os.homedir()
    for (const root of DEFAULT_USER_RUNTIME_READ_ROOTS(homedir)) {
      if (!fs.existsSync(root)) continue
      expect(sbpl).not.toContain(`(deny file-read* (subpath "${root}"))`)
    }
  })

  test("defaultRuntimeReadRoots stays stable for non-darwin platforms", () => {
    const before = defaultRuntimeReadRoots("/home/user")
    expect(before).toContain("/usr/lib")
    expect(before).not.toContain("/opt/homebrew")
  })
})
