import { describe, expect, test } from "bun:test"
import path from "path"
import { buildPermissionContext } from "../../src/session/permission-context"
import { SystemPrompt } from "../../src/session/system"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { registerProjectSessionHealth } from "../../src/project/session-health"
import { $ } from "bun"

registerProjectSessionHealth()

Log.init({ print: false })

function profile() {
  return {
    valid: true,
    label: "Guarded",
    description: "Test",
    ruleset: [],
    filesystem: { readRoots: [], writeRoots: [], protectedPaths: [] },
    network: { mode: "restricted" as const },
    sandbox: { mode: "workspace_write" as const, fallback: "warn" as const },
    approval: {
      mode: "guarded" as const,
      lowRisk: "allow" as const,
      mediumRisk: "ask" as const,
      highRisk: "ask" as const,
    },
    summary: {
      profileId: "guarded" as const,
      sandbox: { mode: "workspace_write" as const, fallback: "warn" as const },
      label: "Guarded",
      brief: "Test",
      approval: {
        mode: "guarded" as const,
        lowRisk: "allow" as const,
        mediumRisk: "ask" as const,
        highRisk: "ask" as const,
      },
      deniedCapabilities: [],
      workspaceRoot: "/",
    },
  }
}

describe("buildPermissionContext with multiple roots", () => {
  test("renders all workspace roots in the permission profile", () => {
    const text = buildPermissionContext(profile() as any, ["/project/main", "/project/folder-a"])
    expect(text).toContain("Workspace roots: /project/main, /project/folder-a")
    expect(text).toContain('<permission_profile id="guarded"')
  })

  test("renders a single root without commas", () => {
    const text = buildPermissionContext(profile() as any, ["/project/main"])
    expect(text).toContain("Workspace roots: /project/main")
  })
})

describe("SystemPrompt.environment with project folders", () => {
  test("lists project folders when a project scope declares sandboxes", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "folder-a")
    await $`mkdir -p ${folder}`.quiet()

    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: tmp.path,
      worktree: tmp.path,
      vcs: "git",
      name: "Test",
      sandboxes: [folder],
      time: { created: 0, updated: 0 },
    }

    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).toContain(`Project folders: ${tmp.path}, ${folder}`)
    expect(text).toContain(`Working directory: ${tmp.path}`)
  })

  test("renders a single project folder line for a plain project", async () => {
    await using tmp = await tmpdir()
    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: tmp.path,
      worktree: tmp.path,
      vcs: "git",
      name: "Test",
      sandboxes: [],
      time: { created: 0, updated: 0 },
    }

    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).toContain(`Project folder: ${tmp.path}`)
  })

  test("does not add a project folder line for the home scope", async () => {
    const scope = {
      type: "home" as const,
      id: "home" as const,
      directory: "/home/test",
      worktree: "/home/test",
    }
    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).not.toContain("Project folders:")
    expect(text).not.toContain("Project folder:")
  })

  test("git_worktree session lists only trusted project folders, never the original checkout", async () => {
    await using tmp = await tmpdir()
    await using sibling = await tmpdir()
    const folder = sibling.path

    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: tmp.path,
      worktree: tmp.path,
      vcs: "git",
      name: "Test",
      sandboxes: [folder],
      time: { created: 0, updated: 0 },
    }
    const worktreePath = path.join(folder, ".synergy", "worktrees", "feature-x")
    const workspace = {
      type: "git_worktree" as const,
      path: worktreePath,
      scopeID: "d_test",
      originalCheckout: tmp.path,
    }

    const [text] = await ScopeContext.provide({
      scope,
      workspace,
      fn: () => SystemPrompt.environment(),
    })

    // The original checkout must never be listed as a trusted project folder,
    // and the prompt must not render a contradictory duplicate line.
    expect(text).not.toContain(`Project folders: ${tmp.path}`)
    expect(text).not.toContain(`Project folders: ${tmp.path}, ${folder}`)
    expect(text).toContain(`Project folder: ${folder}`)
    expect(text).toContain(`Original checkout: ${tmp.path}`)
    expect(text.split("Project folders:").length - 1).toBe(0)
    expect(text.split("Project folder:").length - 1).toBe(1)
  })
})

describe("SystemPrompt.environment git repo line", () => {
  test("reports no for a project scope in a non-git directory (stale snapshot)", async () => {
    await using tmp = await tmpdir()
    // Simulates a session created before git init: the scope snapshot has
    // vcs undefined even though the directory may later become a repo.
    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: tmp.path,
      worktree: tmp.path,
      sandboxes: [],
      time: { created: 0, updated: 0 },
    }

    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).toContain(`Is directory a git repo: no`)
  })

  test("reports yes after git init even with the same stale scope snapshot", async () => {
    await using tmp = await tmpdir()
    const scope: import("../../src/scope").Scope.Project = {
      type: "project",
      id: "d_test",
      directory: tmp.path,
      worktree: tmp.path,
      vcs: undefined,
      sandboxes: [],
      time: { created: 0, updated: 0 },
    }

    // Same scope object (no vcs) is reused across turns; the directory
    // becomes a git repo after the session was created.
    await $`git init`.cwd(tmp.path).quiet()

    const [text] = await ScopeContext.provide({
      scope,
      fn: () => SystemPrompt.environment(),
    })
    expect(text).toContain(`Is directory a git repo: yes`)
  })
})
