import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Worktree } from "../../src/project/worktree"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"

Log.init({ print: false })

describe("git worktree integration", () => {
  test("parses git worktree porcelain output", () => {
    const entries = Worktree.parsePorcelain(
      [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/dev",
        "",
        "worktree /repo/.synergy/worktrees/feature",
        "HEAD def456",
        "detached",
        "",
      ].join("\n"),
    )

    expect(entries).toEqual([
      { path: "/repo", head: "abc123", branch: "dev" },
      { path: "/repo/.synergy/worktrees/feature", head: "def456", detached: true },
    ])
  })

  test("lists main worktree from git as an external main workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const items = await Worktree.list()
          expect(items.some((item) => item.isMain && item.path === scope.worktree)).toBe(true)
          const main = items.find((item) => item.isMain)
          expect(main?.managed).toBe(false)
          expect(main?.owner?.type).toBe("external")
        })(),
    })
  })

  test("creates a managed worktree under .synergy/worktrees and binds the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, ".env.local"), "TOKEN=local")
    await fs.mkdir(path.join(tmp.path, ".synergy"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, ".synergy", "worktree-setup.jsonc"),
      JSON.stringify({ copyIgnored: [".env.local"], setup: ["printf setup > setup.txt"] }),
    )
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const session = await Session.create({ title: "Worktree Test" })
          const created = await Worktree.create({
            name: "feature one",
            sessionID: session.id,
            bind: true,
            baseRef: "current",
          })

          expect(created.managed).toBe(true)
          expect(created.path).toStartWith(path.join(scope.worktree, ".synergy", "worktrees"))
          expect(await Bun.file(path.join(created.path, ".env.local")).text()).toBe("TOKEN=local")
          expect(await Bun.file(path.join(created.path, "setup.txt")).text()).toBe("setup")

          const updated = await Session.get(session.id)
          expect(updated.workspace?.type).toBe("git_worktree")
          expect(updated.workspace?.path).toBe(created.path)
          expect(updated.workspace?.worktreeID).toBe(created.id)

          const listed = await Worktree.list()
          const managed = listed.find((item) => item.id === created.id)
          expect(managed?.bindings).toContain(session.id)
          expect(managed?.owner?.type).toBe("session")

          await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
          await Session.remove(session.id)
        })(),
    })
  })

  test("creates a managed worktree from an explicit base revision", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "later.txt"), "later")
    await $`git add later.txt`.cwd(tmp.path).quiet()
    await $`git commit -m later`.cwd(tmp.path).quiet()
    const baseCommit = (await $`git rev-parse HEAD~1`.cwd(tmp.path).quiet().text()).trim()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const created = await Worktree.create({
            name: "explicit-base",
            baseRef: "current",
            bind: false,
            baseRevision: baseCommit,
          })

          expect(created.baseRevision).toBe(baseCommit)
          expect(created.resolvedBaseCommit).toBe(baseCommit)
          expect(await Bun.file(path.join(created.path, "later.txt")).exists()).toBe(false)
          const head = (await $`git rev-parse HEAD`.cwd(created.path).quiet().text()).trim()
          expect(head).toBe(baseCommit)

          const listed = await Worktree.list()
          const managed = listed.find((item) => item.id === created.id)
          expect(managed?.resolvedBaseCommit).toBe(baseCommit)

          await Worktree.remove({ sessionID: "none", target: created.id, force: true })
        })(),
    })
  })

  test("records superplan worktree owner", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const owner = {
            type: "superplan" as const,
            runID: Identifier.ascending("superplan_run"),
            nodeID: Identifier.ascending("superplan_node"),
          }
          const created = await Worktree.create({
            name: "superplan-node",
            baseRef: "current",
            bind: false,
            owner,
          })

          expect(created.owner).toEqual(owner)
          const listed = await Worktree.list()
          const managed = listed.find((item) => item.id === created.id)
          expect(managed?.owner).toEqual(owner)

          await Worktree.remove({ sessionID: "none", target: created.id, force: true })
        })(),
    })
  })

  test("enter and leave mutate only session workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const session = await Session.create({ title: "Enter Leave" })
          const created = await Worktree.create({ name: "switch target", bind: false, baseRef: "current" })

          await Worktree.enter({ sessionID: session.id, target: created.name, force: false })
          let current = await Session.get(session.id)
          expect(current.workspace?.type).toBe("git_worktree")
          expect(current.workspace?.path).toBe(created.path)
          expect((current.scope as typeof scope).id).toBe(scope.id)

          await Worktree.leave(session.id)
          current = await Session.get(session.id)
          expect(current.workspace?.type).toBe("main")
          expect(current.workspace?.path).toBe(scope.directory)
          expect((current.scope as typeof scope).id).toBe(scope.id)

          await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
          await Session.remove(session.id)
        })(),
    })
  })

  test("throws a clear error for non-git scopes", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await expect(Worktree.list()).rejects.toThrow("git worktree is unavailable")
        })(),
    })
  })
})

function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}

describe("worktree lock invariant", () => {
  type LockResult = { acquired: boolean; existing: boolean }
  function guard(result: unknown): LockResult {
    return result as LockResult
  }

  test("lock reports already-locked worktree as non-acquired instead of throwing", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const created = await Worktree.create({ name: "lock-test-1", bind: false, baseRef: "current" })

          // Pre-lock the worktree externally — simulates a lock left behind
          await $`git worktree lock ${created.path}`.quiet().cwd(scope.worktree)

          // The lock call should not throw — it should report the existing lock
          // Expected contract: Worktree.lock() returns { acquired: boolean, existing: boolean }
          const result = guard(await Worktree.lock(created.path))
          expect(result.acquired).toBe(false)
          expect(result.existing).toBe(true)

          // Cleanup: unlock the pre-existing lock so the worktree can be removed
          await $`git worktree unlock ${created.path}`.quiet().cwd(scope.worktree)
          await Worktree.remove({ sessionID: "none", target: created.id, force: true })
        })(),
    })
  })

  test("fn executes when worktree is already locked", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const created = await Worktree.create({ name: "lock-test-2", bind: false, baseRef: "current" })

          // Pre-lock the worktree externally
          await $`git worktree lock ${created.path}`.quiet().cwd(scope.worktree)

          // Simulate the SessionManager.run pattern: lock, fn, unlock
          const result = guard(await Worktree.lock(created.path))

          let fnRan = false
          try {
            // fn must execute regardless of who owns the lock
            fnRan = true
          } finally {
            if (result.acquired) {
              await Worktree.unlock(created.path)
            }
          }

          expect(fnRan).toBe(true)

          // The pre-existing lock must still be present since Synergy did not acquire it
          const checkLock = await $`git worktree lock ${created.path} 2>&1`.quiet().nothrow().cwd(scope.worktree)
          expect(checkLock.exitCode).not.toBe(0)

          // Cleanup: unlock pre-existing, then remove worktree
          await $`git worktree unlock ${created.path}`.quiet().cwd(scope.worktree)
          await Worktree.remove({ sessionID: "none", target: created.id, force: true })
        })(),
    })
  })

  test("pre-existing lock is not removed after run completion", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const created = await Worktree.create({ name: "lock-test-3", bind: false, baseRef: "current" })

          // Pre-lock the worktree externally
          await $`git worktree lock ${created.path}`.quiet().cwd(scope.worktree)

          // Simulate lock-and-run pattern
          const result = guard(await Worktree.lock(created.path))
          try {
            // fn body — intentionally empty
          } finally {
            if (result.acquired) {
              await Worktree.unlock(created.path)
            }
          }

          // Verify the git lock is STILL present (it was pre-existing, not Synergy's)
          const checkLock = await $`git worktree lock ${created.path} 2>&1`.quiet().nothrow().cwd(scope.worktree)
          expect(checkLock.exitCode).not.toBe(0)
          // stdout captures the error message (2>&1 merged stderr→stdout in Bun shell)
          const msg = new TextDecoder().decode(checkLock.stdout).toLowerCase()
          expect(msg).toMatch(/already/)

          // Cleanup
          await $`git worktree unlock ${created.path}`.quiet().cwd(scope.worktree)
          await Worktree.remove({ sessionID: "none", target: created.id, force: true })
        })(),
    })
  })

  test("synergy-acquired lock is unlocked after run completion", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const created = await Worktree.create({ name: "lock-test-4", bind: false, baseRef: "current" })

          // No pre-existing lock — Synergy should acquire it
          const result = guard(await Worktree.lock(created.path))
          expect(result.acquired).toBe(true)
          expect(result.existing).toBe(false)

          try {
            // fn runs under the lock
          } finally {
            if (result.acquired) {
              await Worktree.unlock(created.path)
            }
          }

          // Verify the git lock has been removed
          const checkLock = await $`git worktree lock ${created.path} 2>&1`.quiet().nothrow().cwd(scope.worktree)
          // Re-locking should succeed (not "already locked")
          expect(checkLock.exitCode).toBe(0)

          // Cleanup
          await $`git worktree unlock ${created.path}`.quiet().cwd(scope.worktree)
          await Worktree.remove({ sessionID: "none", target: created.id, force: true })
        })(),
    })
  })

  test("normal lock returns acquired=true", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const created = await Worktree.create({ name: "lock-test-5", bind: false, baseRef: "current" })

          const result = guard(await Worktree.lock(created.path))
          expect(result.acquired).toBe(true)

          await Worktree.unlock(created.path)
          await Worktree.remove({ sessionID: "none", target: created.id, force: true })
        })(),
    })
  })
})
