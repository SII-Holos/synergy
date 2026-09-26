import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

describe("Scope.fromDirectory", () => {
  test("returns a project scope for a git repository with no commits", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await $`git init`.cwd(tmp.path).quiet()

      const { scope } = await Scope.fromDirectory(tmp.path)

      expect(scope).toBeDefined()
      expect(scope.id).toStartWith("d_")
      expect(scope.type).toBe("project")

      const synergyFile = path.join(tmp.path, ".git", "synergy")
      const fileExists = await Bun.file(synergyFile).exists()
      expect(fileExists).toBe(false)
    }))

  test("returns a project scope for a git repository with commits", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const { scope } = await Scope.fromDirectory(tmp.path)

      expect(scope).toBeDefined()
      expect(scope.id).not.toBe("global")
      expect(scope.type).toBe("project")
      if (scope.type === "project") {
        expect(scope.local!.vcs).toBe("git")
        expect(scope.local!.worktree).toBe(tmp.path)
      }

      const synergyFile = path.join(tmp.path, ".git", "synergy")
      const fileExists = await Bun.file(synergyFile).exists()
      expect(fileExists).toBe(true)
    }))

  test("resolves a transient project scope without registering it", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const { scope } = await Scope.fromDirectory(tmp.path, { persist: false })

      expect(scope.type).toBe("project")
      expect((await Scope.list()).some((item) => item.id === scope.id)).toBe(false)
      expect(await Bun.file(path.join(tmp.path, ".git", "synergy")).exists()).toBe(false)
    }))
})

describe("Scope.fromDirectory with worktrees", () => {
  test("uses the root worktree when called from the root checkout", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const { scope, sandbox } = await Scope.fromDirectory(tmp.path)

      expect(scope.local!.worktree).toBe(tmp.path)
      expect(sandbox).toBe(tmp.path)
      if (scope.type === "project") {
        expect(scope.local!.sandboxes).not.toContain(tmp.path)
      }
    }))

  test("keeps the root worktree when called from a linked worktree", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const worktreePath = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-worktree-test`)
      await $`git worktree add ${worktreePath} -b test-branch`.cwd(tmp.path).quiet()

      try {
        const { scope, sandbox } = await Scope.fromDirectory(worktreePath)

        expect(scope.local!.worktree).toBe(tmp.path)
        expect(sandbox).toBe(worktreePath)
        if (scope.type === "project") {
          expect(scope.local!.directory).toBe(worktreePath)
          expect(scope.local!.sandboxes).toContain(worktreePath)
          expect(scope.local!.sandboxes).not.toContain(tmp.path)

          const listed = (await Scope.list()).find((item) => item.id === scope.id)
          expect(listed?.local?.directory).toBe(tmp.path)

          const fromID = await Scope.fromID(scope.id)
          expect(fromID?.local?.directory).toBe(tmp.path)
        }
      } finally {
        await $`git worktree remove --force ${worktreePath}`.cwd(tmp.path).quiet().nothrow()
      }
    }))

  test("tracks multiple linked worktrees as sandboxes", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const worktree1 = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-worktree-1`)
      const worktree2 = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-worktree-2`)
      await $`git worktree add ${worktree1} -b branch-1`.cwd(tmp.path).quiet()
      await $`git worktree add ${worktree2} -b branch-2`.cwd(tmp.path).quiet()

      try {
        await Scope.fromDirectory(worktree1)
        const { scope } = await Scope.fromDirectory(worktree2)

        expect(scope.local!.worktree).toBe(tmp.path)
        if (scope.type === "project") {
          expect(scope.local!.sandboxes).toContain(worktree1)
          expect(scope.local!.sandboxes).toContain(worktree2)
          expect(scope.local!.sandboxes).not.toContain(tmp.path)
        }
      } finally {
        await $`git worktree remove --force ${worktree1}`.cwd(tmp.path).quiet().nothrow()
        await $`git worktree remove --force ${worktree2}`.cwd(tmp.path).quiet().nothrow()
      }
    }))
})

afterRuntimeTests(() => runtime.close())
