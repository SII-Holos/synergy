import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { WorkspacePolicy } from "../../src/workspace/policy"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"
import fs from "fs/promises"

function isSymlinkPrivilegeError(error: unknown) {
  const code = (error as { code?: unknown })?.code
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES")
}

async function trySymlink(target: string, linkPath: string, type?: "file" | "dir" | "junction") {
  try {
    await fs.symlink(target, linkPath, type)
    return true
  } catch (error) {
    if (isSymlinkPrivilegeError(error)) return false
    throw error
  }
}

describe("WorkspacePolicy", () => {
  // === Requirement 1: WorkspacePolicy.fromSession (main) derives active root from scope.directory ===

  describe("fromSession for main workspace", () => {
    test("active root equals scope.directory when workspace type is main", async () => {
      await using tmp = await tmpdir()
      const scope = await tmp.scope()

      await ScopeContext.provide({
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
      await using tmp = await tmpdir()
      const scope = await tmp.scope()

      await ScopeContext.provide({
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
      await using tmp = await tmpdir()
      const scope = await tmp.scope()

      await ScopeContext.provide({
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
      await using tmp = await tmpdir()
      const scope = await tmp.scope()

      await ScopeContext.provide({
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
      await using tmp = await tmpdir()
      const scope = await tmp.scope()

      const policy = await WorkspacePolicy.fromDefault(scope)

      expect(policy.workspaceType).toBe("main")
      expect(policy.activeRoot).toBe(scope.directory)
    })

    test("fromDefault with explicit workspace uses workspace path", async () => {
      await using tmp = await tmpdir()
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

describe("ScopeContext.contains workspace awareness", () => {
  // === Requirement 4: ScopeContext.contains delegates to WorkspacePolicy ===

  test("ScopeContext.contains returns true for files inside the active workspace directory", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
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
            expect(ScopeContext.contains(subfile)).toBe(true)
          })

          await Session.remove(session.id)
        })(),
    })
  })

  test("ScopeContext.contains returns false for original checkout file when workspace is a git_worktree", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const worktreeDir = path.join(scope.directory, "..", "worktree-feat")
          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(worktreeDir),
            scopeID: scope.id,
          }

          await ScopeContext.provide({
            scope,
            workspace: ws,
            fn: () =>
              using(async () => {
                // A file in the original checkout is outside the active worktree
                const originalFile = path.join(scope.directory, "package.json")
                expect(ScopeContext.contains(originalFile)).toBe(false)

                // A file in the worktree is inside
                const worktreeFile = path.join(ws.path, "README.md")
                expect(ScopeContext.contains(worktreeFile)).toBe(true)
              })(),
          })
        })(),
    })
  })

  test("ScopeContext.contains returns true for worktree file when workspace is a git_worktree", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const worktreeDir = path.join(scope.directory, "..", "worktree-feat2")
          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(worktreeDir),
            scopeID: scope.id,
          }

          await ScopeContext.provide({
            scope,
            workspace: ws,
            fn: () =>
              using(async () => {
                const wf = path.join(ws.path, "feature.ts")
                expect(ScopeContext.contains(wf)).toBe(true)
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

// ===========================================================================
// C. worktree original checkout boundary
// ===========================================================================

describe("WorkspacePolicy — original checkout boundary", () => {
  test("original checkout directory is classified as outside the active workspace", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const worktreePath = path.join(scope.directory, "..", "worktree-boundary")
          const originalCheckout = scope.directory

          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(worktreePath),
            scopeID: scope.id,
            originalCheckout,
          }
          const session = await Session.create({ workspace: ws })
          const policy = await WorkspacePolicy.fromSession(session)

          expect(policy.contains(path.join(ws.path, "src", "lib.ts"))).toBe(true)

          expect(policy.contains(path.join(originalCheckout, "src", "app.ts"))).toBe(false)
          expect(policy.contains(path.join(originalCheckout, "synergy.jsonc"))).toBe(false)
          expect(policy.contains(originalCheckout)).toBe(false)

          await Session.remove(session.id)
        })(),
    })
  })

  test("sibling worktree is classified as outside the active workspace", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const activeWorktreePath = path.join(scope.directory, "..", "worktree-active")
          const siblingWorktreePath = path.join(scope.directory, "..", "worktree-sibling")

          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(activeWorktreePath),
            scopeID: scope.id,
            originalCheckout: scope.directory,
          }
          const session = await Session.create({ workspace: ws })
          const policy = await WorkspacePolicy.fromSession(session)

          expect(policy.contains(path.join(siblingWorktreePath, "file.ts"))).toBe(false)
          expect(policy.contains(siblingWorktreePath)).toBe(false)
          expect(policy.contains(path.join(ws.path, "feature.ts"))).toBe(true)

          await Session.remove(session.id)
        })(),
    })
  })

  test("abs_path_in_original_checkout_outside_in_worktree_mode", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const worktreePath = path.join(scope.directory, "..", "worktree-abs")
          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(worktreePath),
            scopeID: scope.id,
            originalCheckout: scope.directory,
          }
          const session = await Session.create({ workspace: ws })
          const policy = await WorkspacePolicy.fromSession(session)

          const target = path.join(scope.directory, "config", "secrets.json")
          expect(policy.contains(target)).toBe(false)
          expect(policy.contains(scope.directory)).toBe(false)

          await Session.remove(session.id)
        })(),
    })
  })
})

// ===========================================================================
// D. WorkspacePolicy with originalCheckout-aware classifyPath (RED)
// ===========================================================================

describe("WorkspacePolicy.classifyPath for worktree original checkout", () => {
  test("classifyPath(originalCheckoutFile) returns outside with high confidence", async () => {
    await using tmp = await tmpdir()
    const originalCheckout = tmp.path
    const worktreePath = path.join(originalCheckout, "..", "worktree-classify")
    const policy = WorkspacePolicy.create({
      activeRoot: Filesystem.sanitizePath(worktreePath),
      workspaceType: "git_worktree",
      scopeID: "test-scope",
      originalCheckout,
    })

    const targetPath = path.join(originalCheckout, "src", "index.ts")
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, "content")

    const result = policy.classifyPath(targetPath)
    expect(result.boundary).toBe("outside")
    expect(result.confidence).toBe("high")
    expect(typeof result.reason).toBe("string")

    const insidePath = path.join(worktreePath, "src", "lib.ts")
    const insideResult = policy.classifyPath(insidePath)
    expect(insideResult.boundary).toBe("inside")
  })

  test("classifyPath for worktree symlink targeting original checkout returns outside", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const worktreePath = path.join(
            scope.directory,
            "..",
            "worktree-symlink-" + Math.random().toString(36).slice(2),
          )

          await fs.mkdir(worktreePath, { recursive: true })
          const symlinkPath = path.join(worktreePath, "link-to-original")
          const linked = await trySymlink(
            scope.directory,
            symlinkPath,
            process.platform === "win32" ? "junction" : "dir",
          )
          if (!linked) {
            await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
            return
          }

          const ws = {
            type: "git_worktree",
            path: Filesystem.sanitizePath(worktreePath),
            scopeID: scope.id,
            originalCheckout: scope.directory,
          }
          const session = await Session.create({ workspace: ws })
          const policy = await WorkspacePolicy.fromSession(session)

          if (typeof (policy as any).classifyPath !== "function") {
            expect(typeof (policy as any).classifyPath).toBe("function")
            await Session.remove(session.id)
            await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
            return
          }

          const result = (policy as any).classifyPath(symlinkPath)
          expect(result.boundary).toBe("outside")
          expect(result.reason).toMatch(/symlink|realpath|original checkout/i)

          await fs.mkdir(path.join(worktreePath, "nested"), { recursive: true })
          const nestedSymlink = path.join(worktreePath, "nested", "config-link")
          const nestedLinked = await trySymlink(path.join(scope.directory, "synergy.jsonc"), nestedSymlink, "file")
          if (!nestedLinked) {
            await Session.remove(session.id)
            await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
            return
          }

          const nestedResult = (policy as any).classifyPath(nestedSymlink)
          expect(nestedResult.boundary).toBe("outside")

          await Session.remove(session.id)
          await fs.rm(worktreePath, { recursive: true, force: true })

          await fs.unlink(symlinkPath).catch(() => {})
          await fs.unlink(nestedSymlink).catch(() => {})
          await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
        })(),
    })
  })
})

// ===========================================================================
// E. PathClassifier integration with originalCheckout (RED)
// ===========================================================================

describe("PathClassifier originalCheckout boundary classification", () => {
  test("classifyPath detects original checkout paths via PathClassifier", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    const { PathClassifier } = await import("../../src/enforcement/classify")

    const workspace = path.join(scope.directory, "..", "worktree-pc")
    const originalCheckout = scope.directory

    if (typeof (PathClassifier as any).classifyPath === "function") {
      const result = (PathClassifier as any).classifyPath(path.join(originalCheckout, "src/index.ts"), {
        workspace,
        originalCheckout,
      })
      expect(result.boundary).toBe("outside")
      expect(result.confidence).toBe("high")
      expect(result.reason).toMatch(/checkout|original/i)
    } else {
      expect(typeof (PathClassifier as any).classifyPath).toBe("function")
    }
  })

  test("classifyPath detects sibling worktree via originalCheckout awareness", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    const { PathClassifier } = await import("../../src/enforcement/classify")

    const workspace = path.join(scope.directory, "..", "worktree-active-pc")
    const originalCheckout = scope.directory
    const siblingWorktree = path.join(scope.directory, "..", "worktree-sibling-pc")

    if (typeof (PathClassifier as any).classifyPath === "function") {
      const result = (PathClassifier as any).classifyPath(path.join(siblingWorktree, "file.ts"), {
        workspace,
        originalCheckout,
      })
      expect(result.boundary).toBe("outside")

      const origResult = (PathClassifier as any).classifyPath(path.join(originalCheckout, "config.json"), {
        workspace,
        originalCheckout,
      })
      expect(origResult.boundary).toBe("outside")
    } else {
      expect(typeof (PathClassifier as any).classifyPath).toBe("function")
    }
  })
})
