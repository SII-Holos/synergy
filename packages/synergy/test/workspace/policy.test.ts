import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { WorkspacePolicy } from "../../src/workspace/policy"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"
import fs from "fs/promises"

describe("WorkspacePolicy", () => {
  // === Requirement 1: WorkspacePolicy.fromSession (main) derives active root from scope.directory ===

  describe("fromSession for main workspace", () => {
    test("active root equals scope.directory when workspace type is main", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await Instance.provide({
        scope,
        fn: () =>
          using(async () => {
            const session = await Session.create({})
            const policy = await WorkspacePolicy.fromSession(session)

            expect(policy.activeRoot).toBe(scope.directory)
            expect(policy.workspaceType).toBe("main")
            expect(policy.scopeID).toBe(scope.id)

            await Session.remove(session.id)
          })(),
      })
    })

    test("contains returns true for files inside scope.directory in main workspace", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await Instance.provide({
        scope,
        fn: () =>
          using(async () => {
            const subfile = path.join(scope.directory, "src", "app.ts")
            await fs.mkdir(path.dirname(subfile), { recursive: true })
            await fs.writeFile(subfile, "content")

            const session = await Session.create({})
            const policy = await WorkspacePolicy.fromSession(session)

            expect(policy.contains(subfile)).toBe(true)
            expect(policy.contains(path.join(scope.directory, "lib", "util.ts"))).toBe(true)

            await Session.remove(session.id)
          })(),
      })
    })
  })

  // === Requirement 2: git_worktree workspace has active root = workspace.path ===

  describe("fromSession for git_worktree workspace", () => {
    test("active root equals workspace.path when workspace type is git_worktree", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await Instance.provide({
        scope,
        fn: () =>
          using(async () => {
            const worktreePath = path.join(scope.directory, "..", "worktree-v2")
            const ws = {
              type: "git_worktree",
              path: Filesystem.sanitizePath(worktreePath),
              scopeID: scope.id,
            }
            const session = await Session.create({ workspace: ws })

            const policy = await WorkspacePolicy.fromSession(session)

            expect(policy.activeRoot).toBe(ws.path)
            expect(policy.workspaceType).toBe("git_worktree")
            expect(policy.scopeID).toBe(scope.id)

            await Session.remove(session.id)
          })(),
      })
    })

    test("classifies original checkout directory as outside the active workspace", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await Instance.provide({
        scope,
        fn: () =>
          using(async () => {
            const worktreePath = path.join(scope.directory, "..", "worktree-v2")
            const ws = {
              type: "git_worktree",
              path: Filesystem.sanitizePath(worktreePath),
              scopeID: scope.id,
            }
            const session = await Session.create({ workspace: ws })

            const policy = await WorkspacePolicy.fromSession(session)

            // Files in the original checkout (scope.directory) should be outside active workspace
            const mainCheckoutFile = path.join(scope.directory, "src", "app.ts")
            expect(policy.contains(mainCheckoutFile)).toBe(false)

            // Files in the worktree path should be inside
            expect(policy.contains(path.join(ws.path, "src", "lib.ts"))).toBe(true)

            await Session.remove(session.id)
          })(),
      })
    })
  })

  // === Requirement 3: WorkspacePolicy.fromDefault falls back to scope ===

  describe("fromDefault fallback", () => {
    test("returns main workspace policy when no session workspace is present", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      const policy = await WorkspacePolicy.fromDefault(scope)

      expect(policy.workspaceType).toBe("main")
      expect(policy.activeRoot).toBe(scope.directory)
    })

    test("fromDefault with explicit workspace uses workspace path", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      const customPath = path.join(scope.directory, "custom-worktree")

      const policy = await WorkspacePolicy.fromDefault(scope, {
        type: "git_worktree",
        path: customPath,
        scopeID: scope.id,
      })

      expect(policy.activeRoot).toBe(customPath)
      expect(policy.workspaceType).toBe("git_worktree")
    })
  })
})

describe("Instance.contains workspace awareness", () => {
  // === Requirement 4: Instance.contains delegates to WorkspacePolicy ===

  test("Instance.contains returns true for files inside the active workspace directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: () =>
        using(async () => {
          const subfile = path.join(scope.directory, "src", "app.ts")
          await fs.mkdir(path.dirname(subfile), { recursive: true })
          await fs.writeFile(subfile, "content")

          const ws = {
            type: "main",
            path: scope.directory,
            scopeID: scope.id,
          }
          const session = await Session.create({ workspace: ws })

          await SessionManager.run(session.id, async () => {
            expect(Instance.contains(subfile)).toBe(true)
          })

          await Session.remove(session.id)
        })(),
    })
  })

  test("Instance.contains returns false for original checkout file when workspace is a git_worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: () =>
        using(async () => {
          const worktreeDir = path.join(scope.directory, "..", "worktree-feat")
          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(worktreeDir),
            scopeID: scope.id,
          }

          await Instance.provide({
            scope,
            workspace: ws,
            fn: () =>
              using(async () => {
                // A file in the original checkout is outside the active worktree
                const originalFile = path.join(scope.directory, "package.json")
                expect(Instance.contains(originalFile)).toBe(false)

                // A file in the worktree is inside
                const worktreeFile = path.join(ws.path, "README.md")
                expect(Instance.contains(worktreeFile)).toBe(true)
              })(),
          })
        })(),
    })
  })

  test("Instance.contains returns true for worktree file when workspace is a git_worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: () =>
        using(async () => {
          const worktreeDir = path.join(scope.directory, "..", "worktree-feat2")
          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(worktreeDir),
            scopeID: scope.id,
          }

          await Instance.provide({
            scope,
            workspace: ws,
            fn: () =>
              using(async () => {
                const wf = path.join(ws.path, "feature.ts")
                expect(Instance.contains(wf)).toBe(true)
              })(),
          })
        })(),
    })
  })
})
/**
 * Minimal async-dispose helper for sequential async cleanup in tests.
 */
function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}
