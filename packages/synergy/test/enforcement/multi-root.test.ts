import { describe, expect, test } from "bun:test"
import path from "path"
const { EnforcementGate } = await import("../../src/enforcement/gate")
const { buildPermissionProfile } = await import("../../src/sandbox/policy-engine")

// ---------------------------------------------------------------------------
// enforcement/multi-root.test.ts
//
// Multi-root project folders: when a project Scope declares additional
// sandbox folders, the gate must treat paths inside them as inside-workspace
// (file_read / file_write) for guarded/autonomous, while a git_worktree
// session keeps the original checkout outside the trust boundary.
// ---------------------------------------------------------------------------

const MAIN = "/Users/test/multi-root"
const FOLDER_A = "/Users/test/multi-root-folder-a"
const FOLDER_B = "/Users/test/multi-root-folder-b"
const OUTSIDE = "/Users/test/unrelated"

describe("EnforcementGate multi-root trustedRoots", () => {
  test("write inside an additional project folder is classified as file_write", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: MAIN,
      workspaceType: "main",
      trustedRoots: [MAIN, FOLDER_A, FOLDER_B],
    })

    const result = gate.classify("write", {
      filePath: `${FOLDER_A}/src/index.ts`,
    })

    const write = result.capabilities.find((c: any) => c.class === "file_write")!
    expect(write).toBeDefined()
    expect(result.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)

    // guarded allows inside-workspace writes without approval
    const envelope = gate.evaluate("write", { filePath: `${FOLDER_B}/notes.md` })
    expect(envelope.decision).toBe("allow")
  })

  test("read inside an additional project folder is classified as file_read", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: MAIN,
      workspaceType: "main",
      trustedRoots: [MAIN, FOLDER_A, FOLDER_B],
    })

    const result = gate.classify("read", {
      filePath: `${FOLDER_A}/README.md`,
    })

    expect(result.capabilities.some((c: any) => c.class === "file_read")).toBe(true)
    expect(result.capabilities.some((c: any) => c.class === "file_external_read")).toBe(false)
  })

  test("bash write command inside an additional project folder stays inside", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: MAIN,
      workspaceType: "main",
      trustedRoots: [MAIN, FOLDER_A, FOLDER_B],
    })

    const result = gate.classify("bash", {
      command: "touch src/generated.ts",
      workdir: `${FOLDER_A}`,
    })

    expect(result.capabilities.some((c: any) => c.class === "file_external_write")).toBe(false)
    expect(result.capabilities.some((c: any) => c.class === "file_write")).toBe(true)
    expect(result.capabilities.some((c: any) => c.class === "shell_destructive")).toBe(false)
  })

  test("worktree session: executionRoots excludes the original checkout so it stays external", async () => {
    const { tmpdir } = await import("../fixture/fixture")
    const { $ } = await import("bun")
    await using tmp = await tmpdir()
    await using sibling = await tmpdir()
    const main = tmp.path
    const folderA = sibling.path

    const { Scope } = await import("../../src/scope")
    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: main,
      worktree: main,
      vcs: "git",
      sandboxes: [folderA],
      time: { created: 0, updated: 0 },
    }
    const worktreePath = path.join(folderA, ".synergy", "worktrees", "feature-x")
    const roots = Scope.Root.executionRoots(scope, {
      type: "git_worktree",
      path: worktreePath,
      scopeID: "d_test",
      originalCheckout: main,
    })
    // The original checkout is excluded from the trusted roots.
    expect(roots).not.toContain(main)
    expect(roots).toContain(folderA)

    const gate = await EnforcementGate.create({
      activeWorkspace: worktreePath,
      workspaceType: "worktree",
      originalCheckout: main,
      trustedRoots: roots,
    })

    // With the original checkout absent from trustedRoots, a write into it is
    // classified as external and requires approval.
    const result = gate.classify("write", {
      filePath: path.join(main, "packages", "app", "src", "index.ts"),
    })
    const external = result.capabilities.find((c: any) => c.class === "file_external_write")!
    expect(external).toBeDefined()
  })

  test("worktree session: sandbox folder nested inside the original checkout is never trusted", async () => {
    const { tmpdir } = await import("../fixture/fixture")
    const { $ } = await import("bun")
    await using tmp = await tmpdir()
    const main = tmp.path
    // A subdirectory of the main checkout previously opened (auto-recorded
    // into `sandboxes`) must not become a trusted root in a worktree session.
    const nested = path.join(main, "nested")
    await $`mkdir -p ${nested}`.quiet()

    const { Scope } = await import("../../src/scope")
    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: main,
      worktree: main,
      vcs: "git",
      sandboxes: [nested],
      time: { created: 0, updated: 0 },
    }
    const worktreePath = path.join(main, ".synergy", "worktrees", "feature-x")
    const roots = Scope.Root.executionRoots(scope, {
      type: "git_worktree",
      path: worktreePath,
      scopeID: "d_test",
      originalCheckout: main,
    })
    expect(roots).not.toContain(nested)
    expect(roots).not.toContain(main)

    const gate = await EnforcementGate.create({
      activeWorkspace: worktreePath,
      workspaceType: "worktree",
      originalCheckout: main,
      trustedRoots: roots,
    })

    // A write into the nested folder (inside the original checkout) is
    // classified as external — worktree isolation must not be bypassed.
    const result = gate.classify("write", {
      filePath: path.join(nested, "src", "index.ts"),
    })
    const external = result.capabilities.find((c: any) => c.class === "file_external_write")!
    expect(external).toBeDefined()
  })
})

describe("Sandbox policy engine multi-root writable roots", () => {
  test("buildPermissionProfile aggregates all approved roots as writable", () => {
    const profile = buildPermissionProfile({
      workspace: MAIN,
      executionCwd: MAIN,
      sandboxMode: "workspace_write",
      approvedReadPaths: [MAIN, FOLDER_A],
      approvedWritePaths: [MAIN, FOLDER_A],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    expect(profile.fileSystem.writableRoots).toContain(MAIN)
    expect(profile.fileSystem.writableRoots).toContain(FOLDER_A)
    // Each writable root's git tamper surface (hooks/config) stays read-only;
    // the rest of .git (objects/refs/HEAD/index) stays writable for git.
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${MAIN}/.git/hooks`)
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${MAIN}/.git/config`)
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${FOLDER_A}/.git/hooks`)
    expect(profile.fileSystem.readOnlySubpaths).toContain(`${FOLDER_A}/.git/config`)
    expect(profile.fileSystem.readOnlySubpaths).not.toContain(`${MAIN}/.git`)
    expect(profile.fileSystem.readOnlySubpaths).not.toContain(`${FOLDER_A}/.git`)
  })

  test("isMetadataWriteDenied rejects .git writes under every writable root", async () => {
    const { isMetadataWriteDenied } = await import("../../src/sandbox/policy")
    const writableRoots = [MAIN, FOLDER_A]

    expect(isMetadataWriteDenied(writableRoots, `${FOLDER_A}/.git/config`).denied).toBe(true)
    expect(isMetadataWriteDenied(writableRoots, `${FOLDER_A}/src/main.ts`).denied).toBe(false)
    expect(isMetadataWriteDenied(writableRoots, `${OUTSIDE}/file.ts`).denied).toBe(false)
  })
})
