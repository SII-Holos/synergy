import { RuntimeContext } from "../../src/lifecycle/context"
import { describe, expect, test } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import { CREDENTIAL_PATHS, READ_DENY_PATHS, readDenyHomeDirs } from "../../src/sandbox/policy"
import { buildPermissionProfile } from "../../src/sandbox/policy-engine"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

// ---------------------------------------------------------------------------
// sandbox/policy-engine.test.ts
//
// Read-deny-list model shared by the sandbox policy layer: the deny list
// contents (credential paths minus tool-compatibility exemptions), the
// dual-home derivation (OS home + Synergy runtime home), and the profile
// scope rules (ancestor denies kept for nested workspaces, explicit
// dataDenyRoots merged, a deny equal to the workspace dropped but a deny
// inside it kept).
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
  test("keeps the plugin credential root and adds cargo registry tokens", () =>
    runtime.run(() => {
      const home = os.homedir()
      expect(READ_DENY_PATHS(home)).toContain(path.join(home, ".synergy", "data", "plugin"))
      expect(READ_DENY_PATHS(home)).toContain(path.join(home, ".cargo", "credentials.toml"))
      expect(READ_DENY_PATHS(home)).toContain(path.join(home, ".cargo", "credentials"))
    }))

  test("points the Firefox deny at the macOS Application Support profile root", () =>
    runtime.run(() => {
      const home = os.homedir()
      expect(READ_DENY_PATHS(home)).toContain(path.join(home, "Library", "Application Support", "Firefox"))
      expect(READ_DENY_PATHS(home)).not.toContain(path.join(home, "Library", "Firefox"))
    }))

  test("exempts kube and docker config stores from read denial but not write protection", () =>
    runtime.run(() => {
      const home = os.homedir()
      expect(READ_DENY_PATHS(home)).not.toContain(path.join(home, ".kube"))
      expect(READ_DENY_PATHS(home)).not.toContain(path.join(home, ".docker", "config.json"))
      expect(CREDENTIAL_PATHS(home)).toContain(path.join(home, ".kube"))
      expect(CREDENTIAL_PATHS(home)).toContain(path.join(home, ".docker", "config.json"))
    }))
})

describe("readDenyHomeDirs", () => {
  test("protects both the OS home and the explicit Runtime home", () =>
    runtime.run(() => {
      expect(readDenyHomeDirs()).toEqual(expect.arrayContaining([os.homedir(), runtime.host.home]))
    }))
  test("deduplicates a Runtime home that equals the OS home", () =>
    runtime.run(() => {
      const context = RuntimeContext.create({ ...runtime.host, home: os.homedir() })
      try {
        context.run(() => expect(readDenyHomeDirs()).toEqual([os.homedir()]))
      } finally {
        context.dispose()
      }
    }))
})

describe("buildPermissionProfile read deny scope", () => {
  test("keeps the ancestor deny for a workspace nested in a credential directory", () =>
    runtime.run(() => {
      const home = os.homedir()
      const p = profile({ workspace: path.join(home, ".ssh", "proj"), executionCwd: path.join(home, ".ssh", "proj") })
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".ssh"))
    }))

  test("drops a deny equal to the workspace", () =>
    runtime.run(() => {
      const home = os.homedir()
      const p = profile({ workspace: path.join(home, ".ssh"), executionCwd: path.join(home, ".ssh") })
      expect(p.fileSystem.readDenyPaths).not.toContain(path.join(home, ".ssh"))
    }))

  test("keeps a deny inside the workspace", () =>
    runtime.run(() => {
      const p = profile({ dataDenyRoots: ["/srv/project/secrets"] })
      expect(p.fileSystem.readDenyPaths).toContain("/srv/project/secrets")
    }))

  test("keeps every credential deny when the workspace is the OS home", () =>
    runtime.run(() => {
      const home = os.homedir()
      // A Scope directory rooted at $HOME must not be grounds to drop the
      // credential denies: the workspace is the writable root here, so a
      // dropped deny would leave the whole home readable.
      const p = profile({ workspace: home, executionCwd: home, approvedWritePaths: [home] })
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".ssh"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".aws"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".netrc"))
    }))

  test("keeps every credential deny when a trusted root is the OS home", () =>
    runtime.run(() => {
      const home = os.homedir()
      // Additional project folders reach the profile as approvedWritePaths;
      // one of them being $HOME must not prune the credential denies either.
      const p = profile({ approvedWritePaths: ["/srv/other", home] })
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".ssh"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".aws"))
    }))

  test("keeps the credential deny when the workspace is the Synergy runtime home", () =>
    runtime.run(() => {
      const home = os.homedir()
      const p = profile({ workspace: path.join(home, ".synergy"), executionCwd: path.join(home, ".synergy") })
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".ssh"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join(home, ".synergy", "data", "auth"))
    }))

  test("merges explicit non-default dataDenyRoots into the read denies", () =>
    runtime.run(() => {
      const p = profile({ dataDenyRoots: ["/srv/private-data"] })
      expect(p.fileSystem.readDenyPaths).toContain("/srv/private-data")
    }))

  test("does not deny the whole OS home when dataDenyRoots carries the default", () =>
    runtime.run(() => {
      const p = profile({ dataDenyRoots: [os.homedir()] })
      expect(p.fileSystem.readDenyPaths).not.toContain(os.homedir())
    }))

  test("derives credential denies from the explicit Runtime home", () =>
    runtime.run(() => {
      const p = profile()
      expect(p.fileSystem.readDenyPaths).toContain(path.join(runtime.host.home, ".synergy", "data", "auth"))
      expect(p.fileSystem.readDenyPaths).toContain(path.join(runtime.host.home, ".synergy", "data", "plugin"))
    }))
})

afterRuntimeTests(() => runtime.close())
