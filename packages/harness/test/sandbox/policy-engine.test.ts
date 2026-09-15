import { describe, expect, test } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import { CREDENTIAL_PATHS, READ_DENY_PATHS, readDenyHomeDirs } from "../../src/sandbox/policy"
import { buildPermissionProfile } from "../../src/sandbox/policy-engine"

// ---------------------------------------------------------------------------
// sandbox/policy-engine.test.ts
//
// Read-deny-list model shared by the sandbox policy layer: the deny list
// contents (credential paths minus tool-compatibility exemptions), the
// dual-home derivation (OS home + Synergy runtime home), and the profile
// scope rules (ancestor denies kept for nested workspaces, explicit
// dataDenyRoots merged, workspace-internal denies dropped).
//
// Run with:
//   cd packages/harness && bun test test/sandbox/policy-engine.test.ts
// ---------------------------------------------------------------------------

function profile(overrides: Partial<Parameters<typeof buildPermissionProfile>[0]> = {}) {
  return buildPermissionProfile({
    workspace: "/srv/project",
    executionCwd: "/srv/project",
    sandboxMode: "workspace_write",
    approvedReadPaths: [],
    approvedWritePaths: [],
    approvedNetwork: false,
    approvedUnixSockets: [],
    ...overrides,
  })
}

describe("READ_DENY_PATHS", () => {
  test("keeps the plugin credential root and adds cargo registry tokens", () => {
    const home = os.homedir()
    expect(READ_DENY_PATHS(home)).toContain(path.join(home, ".synergy", "data", "plugin"))
    expect(READ_DENY_PATHS(home)).toContain(path.join(home, ".cargo", "credentials.toml"))
    expect(READ_DENY_PATHS(home)).toContain(path.join(home, ".cargo", "credentials"))
  })

  test("points the Firefox deny at the macOS Application Support profile root", () => {
    const home = os.homedir()
    expect(READ_DENY_PATHS(home)).toContain(path.join(home, "Library", "Application Support", "Firefox"))
    expect(READ_DENY_PATHS(home)).not.toContain(path.join(home, "Library", "Firefox"))
  })

  test("exempts kube and docker config stores from read denial but not write protection", () => {
    const home = os.homedir()
    expect(READ_DENY_PATHS(home)).not.toContain(path.join(home, ".kube"))
    expect(READ_DENY_PATHS(home)).not.toContain(path.join(home, ".docker", "config.json"))
    expect(CREDENTIAL_PATHS(home)).toContain(path.join(home, ".kube"))
    expect(CREDENTIAL_PATHS(home)).toContain(path.join(home, ".docker", "config.json"))
  })
})

describe("readDenyHomeDirs", () => {
  test("derives from the OS home plus SYNERGY_HOME when set", () => {
    const savedHome = process.env.SYNERGY_HOME
    process.env.SYNERGY_HOME = "/tmp/alt-synergy-home"
    try {
      const dirs = readDenyHomeDirs()
      expect(dirs).toContain("/tmp/alt-synergy-home")
      expect(dirs).toContain(os.homedir())
    } finally {
      if (savedHome === undefined) delete process.env.SYNERGY_HOME
      else process.env.SYNERGY_HOME = savedHome
    }
  })

  test("collapses to the OS home when no runtime home env is set", () => {
    const savedHome = process.env.SYNERGY_HOME
    const savedTestHome = process.env.SYNERGY_TEST_HOME
    delete process.env.SYNERGY_HOME
    delete process.env.SYNERGY_TEST_HOME
    try {
      expect(readDenyHomeDirs()).toEqual([os.homedir()])
    } finally {
      if (savedHome !== undefined) process.env.SYNERGY_HOME = savedHome
      if (savedTestHome !== undefined) process.env.SYNERGY_TEST_HOME = savedTestHome
    }
  })
})

describe("buildPermissionProfile read deny scope", () => {
  test("keeps the ancestor deny for a workspace nested in a credential directory", () => {
    const home = os.homedir()
    const p = profile({ workspace: path.join(home, ".ssh", "proj"), executionCwd: path.join(home, ".ssh", "proj") })
    expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".ssh"))
  })

  test("drops a deny equal to the workspace", () => {
    const home = os.homedir()
    const p = profile({ workspace: path.join(home, ".ssh"), executionCwd: path.join(home, ".ssh") })
    expect(p.fileSystem.readDenyPaths).not.toContain(path.join(home, ".ssh"))
  })

  test("drops a deny inside the workspace", () => {
    const p = profile({ dataDenyRoots: ["/srv/project/secrets"] })
    expect(p.fileSystem.readDenyPaths).not.toContain("/srv/project/secrets")
  })

  test("merges explicit non-default dataDenyRoots into the read denies", () => {
    const p = profile({ dataDenyRoots: ["/srv/private-data"] })
    expect(p.fileSystem.readDenyPaths).toContain("/srv/private-data")
  })

  test("does not deny the whole OS home when dataDenyRoots carries the default", () => {
    const p = profile({ dataDenyRoots: [os.homedir()] })
    expect(p.fileSystem.readDenyPaths).not.toContain(os.homedir())
  })

  test("derives denies from the Synergy runtime home when it differs", () => {
    const savedHome = process.env.SYNERGY_HOME
    process.env.SYNERGY_HOME = "/tmp/alt-synergy-home"
    try {
      const p = profile()
      expect(p.fileSystem.readDenyPaths).toContain(path.join("/tmp/alt-synergy-home", ".synergy", "data", "auth"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join("/tmp/alt-synergy-home", ".synergy", "data", "plugin"))
    } finally {
      if (savedHome === undefined) delete process.env.SYNERGY_HOME
      else process.env.SYNERGY_HOME = savedHome
    }
  })
})
