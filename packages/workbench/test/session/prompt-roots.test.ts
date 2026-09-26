import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { buildPermissionContext } from "@ericsanchezok/synergy-harness/test/internal/session/permission-context"
import { SystemPrompt } from "@ericsanchezok/synergy-harness/test/internal/session/system"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { $ } from "bun"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

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
  test("renders all workspace roots in the permission profile", () =>
    runtime.run(() => {
      const text = buildPermissionContext(profile() as any, ["/project/main", "/project/folder-a"])
      expect(text).toContain("Workspace roots: /project/main, /project/folder-a")
      expect(text).toContain('<permission_profile id="guarded"')
    }))

  test("renders a single root without commas", () =>
    runtime.run(() => {
      const text = buildPermissionContext(profile() as any, ["/project/main"])
      expect(text).toContain("Workspace roots: /project/main")
    }))
})

describe("SystemPrompt.environment with Workspace write roots", () => {
  test("declaring project sandboxes does not share write access", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const folder = path.join(tmp.path, "folder-a")
      await $`mkdir -p ${folder}`.quiet()

      const scope: import("@ericsanchezok/synergy-harness/scope").Scope.Project = {
        type: "project",
        id: "d_test",
        local: { directory: tmp.path, worktree: tmp.path, vcs: "git", sandboxes: [folder] },

        name: "Test",

        time: { created: 0, updated: 0 },
      }

      const [text] = await ScopeContext.provide({
        scope,
        fn: () => SystemPrompt.environment(),
      })
      expect(text.split("\n").find((line) => line.includes("Writable workspace directories:"))).toBe(
        `  Writable workspace directories: ${tmp.path}`,
      )
      expect(text).toContain(`Working directory: ${tmp.path}`)
    }))

  test("renders the current Workspace as the only default write root", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope: import("@ericsanchezok/synergy-harness/scope").Scope.Project = {
        type: "project",
        id: "d_test",
        local: { directory: tmp.path, worktree: tmp.path, vcs: "git", sandboxes: [] },

        name: "Test",

        time: { created: 0, updated: 0 },
      }

      const [text] = await ScopeContext.provide({
        scope,
        fn: () => SystemPrompt.environment(),
      })
      expect(text).toContain(`Writable workspace directories: ${tmp.path}`)
    }))

  test("a session without a Workspace exposes no local write root", () =>
    runtime.run(async () => {
      const scope = {
        type: "home" as const,
        id: "home" as const,
        local: null,
      }
      const [text] = await ScopeContext.provide({
        scope,
        fn: () => SystemPrompt.environment(),
      })
      expect(text).not.toContain("Writable workspace directories:")
      expect(text).toContain("Workspace: none.")
    }))

  test("a worktree uses its own root without granting its parent or original checkout", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await using sibling = await tmpdir()
      const folder = sibling.path

      const scope: import("@ericsanchezok/synergy-harness/scope").Scope.Project = {
        type: "project",
        id: "d_test",
        local: { directory: tmp.path, worktree: tmp.path, vcs: "git", sandboxes: [folder] },

        name: "Test",

        time: { created: 0, updated: 0 },
      }
      const worktreePath = path.join(folder, ".synergy", "worktrees", "feature-x")
      await fs.mkdir(worktreePath, { recursive: true })
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

      expect(text.split("\n").find((line) => line.includes("Writable workspace directories:"))).toBe(
        `  Writable workspace directories: ${worktreePath}`,
      )
      expect(text).toContain(`Original checkout: ${tmp.path}`)
    }))

  test("renders an explicitly shared Workspace alongside the current write root", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await using shared = await tmpdir()
      const scope = await tmp.scope()
      const own = await WorkspaceBinding.register(scope.id, tmp.path)
      const target = await WorkspaceBinding.register(scope.id, shared.path)
      await WorkspaceBinding.setSharing(own.id, {
        scopeID: scope.id,
        expectedRevision: own.revision,
        workspaceIDs: [target.id],
      })
      const [text] = await ScopeContext.provide({ scope, fn: () => SystemPrompt.environment() })
      expect(text).toContain(`Writable workspace directories: ${tmp.path}, ${shared.path}`)
    }))
})

describe("SystemPrompt.environment git repo line", () => {
  test("reports no for a project scope in a non-git directory (stale snapshot)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      // Simulates a session created before git init: the scope snapshot has
      // vcs undefined even though the directory may later become a repo.
      const scope: import("@ericsanchezok/synergy-harness/scope").Scope.Project = {
        type: "project",
        id: "d_test",
        local: { directory: tmp.path, worktree: tmp.path, sandboxes: [] },

        time: { created: 0, updated: 0 },
      }

      const [text] = await ScopeContext.provide({
        scope,
        fn: () => SystemPrompt.environment(),
      })
      expect(text).toContain(`Is directory a git repo: no`)
    }))

  test("reports yes after git init even with the same stale scope snapshot", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope: import("@ericsanchezok/synergy-harness/scope").Scope.Project = {
        type: "project",
        id: "d_test",
        local: { directory: tmp.path, worktree: tmp.path, vcs: undefined, sandboxes: [] },

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
    }))
})

afterRuntimeTests(() => runtime.close())
