// ---------------------------------------------------------------------------
// sandbox/phase2-linux-config.test.ts
//
// RED tests for Phase 2 Linux config: SynergySandboxPermissionProfile JSON shape.
// These tests define the target contract BEFORE implementation.
//
// Six behaviors tested:
//   1. buildPermissionProfile produces fileSystem.workspace matching input.
//   2. fileSystem.readableRoots includes workspace + platform reads + approved paths.
//   3. fileSystem.writableRoots includes workspace for workspace_write; empty for read_only.
//   4. fileSystem.readOnlySubpaths includes all DEFAULT_PROTECTED_PATHS as read-only.
//   5. fileSystem.protectedPaths includes credential paths and workspace .git/.synergy.
//   6. network.mode reflects approvedNetwork boolean (full vs restricted).
//
// Constraints:
//   - Deterministic on macOS; no real Linux execution.
//   - Test the data shape, not the consumer.
//   - No source text greps.
//
// Run with:
//   cd packages/synergy && bun test test/sandbox/phase2-linux-config.test.ts
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test"
import { buildPermissionProfile } from "../../src/sandbox/policy-engine"
import { DEFAULT_PROTECTED_PATHS, protectedMetadataUnderWritableRoot } from "../../src/sandbox/policy"
import * as os from "os"

// ==================================================================
// 1. Profile structure has correct top-level shape
// ==================================================================
describe("Phase 2: buildPermissionProfile top-level shape", () => {
  test("returns fileSystem and network properties", () => {
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile).toHaveProperty("fileSystem")
    expect(profile).toHaveProperty("network")
    expect(typeof profile.fileSystem).toBe("object")
    expect(typeof profile.network).toBe("object")
  })

  test("fileSystem.workspace matches input workspace", () => {
    const workspace = "/home/user/project"

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: workspace,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.workspace).toBe(workspace)
  })

  test("fileSystem.includePlatformDefaults is true", () => {
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.includePlatformDefaults).toBe(true)
  })
})

// ==================================================================
// 2. fileSystem.readableRoots
// ==================================================================
describe("Phase 2: fileSystem.readableRoots", () => {
  test("includes workspace in readableRoots", () => {
    const workspace = "/home/user/project"

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: workspace,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.readableRoots).toContain(workspace)
  })

  test("includes platform default read roots", () => {
    const homedir = os.homedir()
    // Platform roots include /usr/lib, /bin, /usr/bin, .bun, .gitconfig, etc.
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    // At minimum, platform roots must contain sensible system paths
    const allRoots = profile.fileSystem.readableRoots
    expect(allRoots.length).toBeGreaterThan(1)

    // Must include some standard platform paths
    // (Actual contents depend on platform, but workspace is always present)
    const hasPlatformPath = allRoots.some(
      (r: string) => r.startsWith("/usr/") || r.startsWith("/bin") || r.includes(".bun"),
    )
    expect(hasPlatformPath).toBe(true)
  })

  test("includes approved read paths from permission system", () => {
    const approvedRead = ["/data/datasets", "/shared/models"]

    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: approvedRead,
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    for (const p of approvedRead) {
      expect(profile.fileSystem.readableRoots).toContain(p)
    }
  })

  test("executionCwd is readable when different from workspace", () => {
    const workspace = "/home/user/project"
    const executionCwd = "/home/user/project/packages/core"

    const profile = buildPermissionProfile({
      workspace,
      executionCwd,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.readableRoots).toContain(executionCwd)
  })
})

// ==================================================================
// 3. fileSystem.writableRoots
// ==================================================================
describe("Phase 2: fileSystem.writableRoots", () => {
  test("includes workspace for workspace_write mode", () => {
    const workspace = "/home/user/project"

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: workspace,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.writableRoots).toContain(workspace)
  })

  test("does NOT include workspace for read_only mode", () => {
    const workspace = "/home/user/project"

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: workspace,
      sandboxMode: "read_only",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.writableRoots).not.toContain(workspace)
    expect(profile.fileSystem.writableRoots.length).toBe(0)
  })

  test("includes approved write paths when in workspace_write mode", () => {
    const approvedWrites = ["/tmp/output", "/var/cache/build"]

    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: approvedWrites,
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    for (const p of approvedWrites) {
      expect(profile.fileSystem.writableRoots).toContain(p)
    }
  })

  test("excludes approved write paths in read_only mode", () => {
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "read_only",
      approvedReadPaths: [],
      approvedWritePaths: ["/tmp/output"],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    // read_only mode should have no writable roots at all
    expect(profile.fileSystem.writableRoots.length).toBe(0)
  })
})

// ==================================================================
// 4. fileSystem.readOnlySubpaths — protected paths as read-only
// ==================================================================
describe("Phase 2: fileSystem.readOnlySubpaths", () => {
  test("includes workspace-protected paths as readOnlySubpaths when workspace is writable", () => {
    const homedir = os.homedir()
    const workspace = "/home/user/project"
    const protectedPaths = DEFAULT_PROTECTED_PATHS(homedir, workspace)

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: workspace,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    // Only protected paths under the writable workspace root should be in readOnlySubpaths
    for (const p of protectedPaths) {
      if (p.startsWith(workspace + "/")) {
        expect(profile.fileSystem.readOnlySubpaths).toContain(p)
      } else {
        expect(profile.fileSystem.readOnlySubpaths).not.toContain(p)
      }
    }
  })

  test("workspace .git and .synergy are in readOnlySubpaths", () => {
    const workspace = "/home/user/project"

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: workspace,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    // Workspace .git is writable by workspace_write but must be read-only
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${workspace}/.git`)
    // Workspace .synergy is writable by workspace_write but must be read-only
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${workspace}/.synergy`)
  })

  test("credential paths appear in readOnlySubpaths when homedir is writable", () => {
    const homedir = os.homedir()

    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [homedir],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    // Key credential paths must be read-only when homedir is a writable root
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${homedir}/.ssh`)
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${homedir}/.aws`)
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${homedir}/.netrc`)
  })
})

// ==================================================================
// 5. fileSystem.protectedPaths
// ==================================================================
describe("Phase 2: fileSystem.protectedPaths", () => {
  test("contains credential and workspace paths", () => {
    const homedir = os.homedir()
    const workspace = "/home/user/project"
    const expected = DEFAULT_PROTECTED_PATHS(homedir, workspace)

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: workspace,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.protectedPaths.length).toBe(expected.length)
    for (const p of expected) {
      expect(profile.fileSystem.protectedPaths).toContain(p)
    }
  })

  test("protectedPaths includes Synergy auth/config/sensitive data", () => {
    const homedir = os.homedir()

    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    const paths = profile.fileSystem.protectedPaths
    expect(paths).toContain(`${homedir}/.synergy/config`)
    expect(paths).toContain(`${homedir}/.synergy/data/auth`)
  })
})

// ==================================================================
// 6. network.mode
// ==================================================================
describe("Phase 2: network.mode", () => {
  test("approvedNetwork true → network.mode is full", () => {
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: true,
      approvedUnixSockets: [],
    })

    expect(profile.network.mode).toBe("full")
    expect(profile.network.allowLocalBinding).toBe(true)
  })

  test("approvedNetwork false → network.mode is restricted", () => {
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.network.mode).toBe("restricted")
  })

  test("approved unix sockets are reflected when network is full", () => {
    const sockets = ["/var/run/docker.sock"]

    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: true,
      approvedUnixSockets: sockets,
    })

    expect(profile.network.allowedUnixSockets).toContain("/var/run/docker.sock")
  })

  test("approved unix sockets are empty when network is restricted", () => {
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: ["/var/run/docker.sock"],
    })

    expect(profile.network.allowedUnixSockets.length).toBe(0)
  })
})

// ==================================================================
// 7. fileSystem.dataDenyRoots
// ==================================================================
describe("Phase 2: fileSystem.dataDenyRoots", () => {
  test("contains homedir by default", () => {
    const homedir = os.homedir()

    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.dataDenyRoots).toContain(homedir)
  })
})

// ==================================================================
// 8. Profile JSON serialization shape (for Rust helper interop)
// ==================================================================
describe("Phase 2: profile JSON serialization", () => {
  test("serializes to JSON matching expected helper config schema", () => {
    const profile = buildPermissionProfile({
      workspace: "/home/user/project",
      executionCwd: "/home/user/project",
      sandboxMode: "workspace_write",
      approvedReadPaths: ["/data/datasets"],
      approvedWritePaths: ["/tmp/output"],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    const json = JSON.parse(JSON.stringify(profile))

    // Top-level keys
    expect(json).toHaveProperty("fileSystem")
    expect(json).toHaveProperty("network")

    const fs2 = json.fileSystem

    // Required fields per SynergyFileSystemSandboxPolicy
    expect(fs2).toHaveProperty("workspace")
    expect(fs2).toHaveProperty("readableRoots")
    expect(fs2).toHaveProperty("writableRoots")
    expect(fs2).toHaveProperty("readOnlySubpaths")
    expect(fs2).toHaveProperty("unreadableGlobs")
    expect(fs2).toHaveProperty("protectedMetadataNames")
    expect(fs2).toHaveProperty("protectedPaths")
    expect(fs2).toHaveProperty("dataDenyRoots")
    expect(fs2).toHaveProperty("includePlatformDefaults")

    // Array fields
    expect(Array.isArray(fs2.readableRoots)).toBe(true)
    expect(Array.isArray(fs2.writableRoots)).toBe(true)
    expect(Array.isArray(fs2.readOnlySubpaths)).toBe(true)
    expect(Array.isArray(fs2.unreadableGlobs)).toBe(true)
    expect(Array.isArray(fs2.protectedMetadataNames)).toBe(true)
    expect(Array.isArray(fs2.protectedPaths)).toBe(true)
    expect(Array.isArray(fs2.dataDenyRoots)).toBe(true)

    // Network fields
    const net = json.network
    expect(net).toHaveProperty("mode")
    expect(net).toHaveProperty("allowLocalBinding")
    expect(net).toHaveProperty("allowedUnixSockets")
    expect(Array.isArray(net.allowedUnixSockets)).toBe(true)

    // Specific values
    expect(fs2.workspace).toBe("/home/user/project")
    expect(fs2.includePlatformDefaults).toBe(true)
    expect(fs2.readableRoots).toContain("/data/datasets")
    expect(fs2.writableRoots).toContain("/tmp/output")
    expect(net.mode).toBe("restricted")
    expect(net.allowLocalBinding).toBe(true)
  })
})

// ==================================================================
// 9. protectedMetadataUnderWritableRoot — policy-layer write intercept
// ==================================================================
describe("Phase 2: protectedMetadataUnderWritableRoot", () => {
  test("identifies .git when workspace is writable", () => {
    const workspace = "/home/user/project"
    const protectedPaths = [`${workspace}/.git`, `${workspace}/.synergy`]
    const writableRoots = [workspace]

    const result = protectedMetadataUnderWritableRoot(writableRoots, protectedPaths, workspace)

    expect(result).toContain(`${workspace}/.git`)
    expect(result).toContain(`${workspace}/.synergy`)
    expect(result.length).toBe(2)
  })

  test("identifies ~/.ssh when homedir is writable", () => {
    const homedir = "/home/testuser"
    const workspace = "/home/user/project"
    const protectedPaths = [`${homedir}/.ssh`, `${homedir}/.aws`, `${workspace}/.git`]
    const writableRoots = [homedir]

    const result = protectedMetadataUnderWritableRoot(writableRoots, protectedPaths, workspace)

    expect(result).toContain(`${homedir}/.ssh`)
    expect(result).toContain(`${homedir}/.aws`)
    expect(result).not.toContain(`${workspace}/.git`)
    expect(result.length).toBe(2)
  })

  test("paths outside writable roots are not included", () => {
    const workspace = "/home/user/project"
    const protectedPaths = [`${workspace}/.git`, "/home/user/.ssh", "/etc/passwd"]
    const writableRoots = [workspace]

    const result = protectedMetadataUnderWritableRoot(writableRoots, protectedPaths, workspace)

    expect(result).toContain(`${workspace}/.git`)
    expect(result).not.toContain("/home/user/.ssh")
    expect(result).not.toContain("/etc/passwd")
    expect(result.length).toBe(1)
  })

  test("returns empty array when no writable roots", () => {
    const workspace = "/home/user/project"
    const protectedPaths = [`${workspace}/.git`, `/home/user/.ssh`]

    const result = protectedMetadataUnderWritableRoot([], protectedPaths, workspace)

    expect(result).toEqual([])
  })

  test("returns empty array when no protected paths under writable roots", () => {
    const workspace = "/home/user/project"
    const writableRoots = ["/tmp/scratch"]
    const protectedPaths = [`${workspace}/.git`, `/home/user/.ssh`]

    const result = protectedMetadataUnderWritableRoot(writableRoots, protectedPaths, workspace)

    expect(result).toEqual([])
  })
})
