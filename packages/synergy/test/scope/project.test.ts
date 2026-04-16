import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Scope.fromDirectory", () => {
  test("returns a project scope for a git repository with no commits", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()

    const { scope } = await Scope.fromDirectory(tmp.path)

    expect(scope).toBeDefined()
    expect(scope.id).toStartWith("d_")
    expect(scope.type).toBe("project")

    const synergyFile = path.join(tmp.path, ".git", "synergy")
    const fileExists = await Bun.file(synergyFile).exists()
    expect(fileExists).toBe(false)
  })

  test("returns a project scope for a git repository with commits", async () => {
    await using tmp = await tmpdir({ git: true })

    const { scope } = await Scope.fromDirectory(tmp.path)

    expect(scope).toBeDefined()
    expect(scope.id).not.toBe("global")
    expect(scope.type).toBe("project")
    if (scope.type === "project") {
      expect(scope.vcs).toBe("git")
      expect(scope.worktree).toBe(tmp.path)
    }

    const synergyFile = path.join(tmp.path, ".git", "synergy")
    const fileExists = await Bun.file(synergyFile).exists()
    expect(fileExists).toBe(true)
  })
})

describe("Scope.fromDirectory with worktrees", () => {
  test("uses the root worktree when called from the root checkout", async () => {
    await using tmp = await tmpdir({ git: true })

    const { scope, sandbox } = await Scope.fromDirectory(tmp.path)

    expect(scope.worktree).toBe(tmp.path)
    expect(sandbox).toBe(tmp.path)
    if (scope.type === "project") {
      expect(scope.sandboxes).not.toContain(tmp.path)
    }
  })

  test("keeps the root worktree when called from a linked worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    const worktreePath = path.join(tmp.path, "..", "worktree-test")
    await $`git worktree add ${worktreePath} -b test-branch`.cwd(tmp.path).quiet()

    const { scope, sandbox } = await Scope.fromDirectory(worktreePath)

    expect(scope.worktree).toBe(tmp.path)
    expect(sandbox).toBe(worktreePath)
    if (scope.type === "project") {
      expect(scope.sandboxes).toContain(worktreePath)
      expect(scope.sandboxes).not.toContain(tmp.path)
    }

    await $`git worktree remove ${worktreePath}`.cwd(tmp.path).quiet()
  })

  test("tracks multiple linked worktrees as sandboxes", async () => {
    await using tmp = await tmpdir({ git: true })

    const worktree1 = path.join(tmp.path, "..", "worktree-1")
    const worktree2 = path.join(tmp.path, "..", "worktree-2")
    await $`git worktree add ${worktree1} -b branch-1`.cwd(tmp.path).quiet()
    await $`git worktree add ${worktree2} -b branch-2`.cwd(tmp.path).quiet()

    await Scope.fromDirectory(worktree1)
    const { scope } = await Scope.fromDirectory(worktree2)

    expect(scope.worktree).toBe(tmp.path)
    if (scope.type === "project") {
      expect(scope.sandboxes).toContain(worktree1)
      expect(scope.sandboxes).toContain(worktree2)
      expect(scope.sandboxes).not.toContain(tmp.path)
    }

    await $`git worktree remove ${worktree1}`.cwd(tmp.path).quiet()
    await $`git worktree remove ${worktree2}`.cwd(tmp.path).quiet()
  })
})
