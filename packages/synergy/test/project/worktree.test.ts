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
import { Server } from "../../src/server/server"
import { SessionManager } from "../../src/session/manager"

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
    const setupCommand = process.platform === "win32" ? "<nul set /p dummy=setup>setup.txt" : "printf setup > setup.txt"
    await fs.writeFile(path.join(tmp.path, ".env.local"), "TOKEN=local")
    await fs.mkdir(path.join(tmp.path, ".synergy"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, ".synergy", "worktree-setup.jsonc"),
      JSON.stringify({ copyIgnored: [".env.local"], setup: [setupCommand] }),
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
          expect(created.name).toStartWith("synergy-feature-one-")
          expect(created.name).not.toContain("synergy-synergy")
          expect(created.branch).toStartWith("synergy/feature-one-")
          expect(created.branch).not.toContain("synergy/synergy")
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

  test("POST /session with workspace create returns a git worktree session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const app = Server.App()
          const response = await app.request(`/session?directory=${encodeURIComponent(scope.worktree)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "Route Worktree",
              workspace: { mode: "create", name: "route-worktree" },
            }),
          })

          expect(response.status).toBe(200)
          const session = await response.json()
          expect(session.workspace?.type).toBe("git_worktree")
          expect(session.workspace?.path).toStartWith(path.join(scope.worktree, ".synergy", "worktrees"))
          expect(session.workspace?.name).toStartWith("synergy-route-worktree-")
          expect(session.workspace?.branch).toStartWith("synergy/route-worktree-")
          expect(session.workspace?.branch).not.toContain("synergy/synergy")
          expect(session.workspace?.originalCheckout).toBe(scope.worktree)
          expect(session.scope.directory).toBe(scope.worktree)

          await Worktree.remove({ sessionID: session.id, target: session.workspace.worktreeID, force: true })
          await Session.remove(session.id)
        })(),
    })
  })

  test("workspace create falls back to branded session names for default titles", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const session = await Session.create()
          const created = await Worktree.create({
            sessionID: session.id,
            bind: true,
            baseRef: "current",
          })

          expect(created.name).toStartWith("synergy-session-")
          expect(created.name).not.toContain("new-session")
          expect(created.branch).toStartWith("synergy/session-")
          expect(created.branch).not.toContain("new-session")

          await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
          await Session.remove(session.id)
        })(),
    })
  })

  test("POST /experimental/worktree/session/:id/enter binds an existing worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const app = Server.App()
          const session = await Session.create({ title: "Route Enter Worktree" })
          const created = await Worktree.create({ name: "route-enter", bind: false, baseRef: "current" })

          const response = await app.request(
            `/experimental/worktree/session/${session.id}/enter?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: created.id }),
            },
          )

          expect(response.status).toBe(200)
          const updated = await response.json()
          expect(updated.workspace?.type).toBe("git_worktree")
          expect(updated.workspace?.path).toBe(created.path)
          expect(updated.workspace?.worktreeID).toBe(created.id)

          const listed = await Worktree.list()
          const managed = listed.find((item) => item.id === created.id)
          expect(managed?.bindings).toContain(session.id)

          await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
          await Session.remove(session.id)
        })(),
    })
  })

  test("POST /session cleans up the session if workspace creation fails", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const app = Server.App()
          const sessionID = Identifier.descending("session")
          const response = await app.request(`/session?directory=${encodeURIComponent(scope.worktree)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: sessionID,
              workspace: { mode: "create", baseRevision: "missing-revision-for-test" },
            }),
          })

          expect(response.status).toBe(400)
          expect(await SessionManager.getSession(sessionID)).toBeUndefined()
        })(),
    })
  })

  test("HTTP worktree create, enter, and leave reject running sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const app = Server.App()
          const session = await Session.create({ title: "Busy Session" })
          const created = await Worktree.create({ name: "busy-enter", bind: false, baseRef: "current" })
          SessionManager.registerRuntime(session.id)
          SessionManager.acquire(session.id)

          try {
            const create = await app.request(`/experimental/worktree?directory=${encodeURIComponent(scope.worktree)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionID: session.id, bind: true }),
            })
            expect(create.status).toBe(400)
            expect((await create.json()).name).toBe("WorktreeSessionBusyError")

            const enter = await app.request(
              `/experimental/worktree/session/${session.id}/enter?directory=${encodeURIComponent(scope.worktree)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ target: created.id }),
              },
            )
            expect(enter.status).toBe(400)
            expect((await enter.json()).name).toBe("WorktreeSessionBusyError")

            const leave = await app.request(
              `/experimental/worktree/session/${session.id}/leave?directory=${encodeURIComponent(scope.worktree)}`,
              { method: "POST" },
            )
            expect(leave.status).toBe(400)
            expect((await leave.json()).name).toBe("WorktreeSessionBusyError")
          } finally {
            await SessionManager.release(session.id)
            await Worktree.remove({ sessionID: "none", target: created.id, force: true }).catch(() => undefined)
            await Session.remove(session.id)
          }
        })(),
    })
  })

  test("core worktree APIs still work while a session is running", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const session = await Session.create({ title: "Running Core Worktree" })
          SessionManager.registerRuntime(session.id)
          SessionManager.acquire(session.id)

          let created: Worktree.Info | undefined
          try {
            created = await Worktree.create({
              name: "running-core",
              sessionID: session.id,
              bind: true,
              baseRef: "current",
            })
            expect((await Session.get(session.id)).workspace?.type).toBe("git_worktree")

            await Worktree.leave(session.id)
            expect((await Session.get(session.id)).workspace?.type).toBe("main")
          } finally {
            await SessionManager.release(session.id)
            if (created) await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
            await Session.remove(session.id)
          }
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

  test("remove leaves all bound sessions back to main before deleting the worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const session1 = await Session.create({ title: "Remove Bind Test 1" })
          const session2 = await Session.create({ title: "Remove Bind Test 2" })
          const created = await Worktree.create({
            name: "remove-bind",
            sessionID: session1.id,
            bind: true,
            baseRef: "current",
          })
          await Worktree.enter({ sessionID: session2.id, target: created.id, force: false })

          expect((await Session.get(session1.id)).workspace?.type).toBe("git_worktree")
          expect((await Session.get(session2.id)).workspace?.type).toBe("git_worktree")

          await Worktree.remove({ sessionID: session1.id, target: created.id, force: true })

          const s1 = await Session.get(session1.id)
          const s2 = await Session.get(session2.id)
          expect(s1.workspace?.type).toBe("main")
          expect(s2.workspace?.type).toBe("main")

          const listed = await Worktree.list()
          expect(listed.find((item) => item.id === created.id)).toBeUndefined()

          await Session.remove(session1.id)
          await Session.remove(session2.id)
        })(),
    })
  })

  test("remove rejects when a bound session is running", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const session = await Session.create({ title: "Busy Remove" })
          const created = await Worktree.create({
            name: "busy-remove",
            sessionID: session.id,
            bind: true,
            baseRef: "current",
          })

          SessionManager.registerRuntime(session.id)
          SessionManager.acquire(session.id)

          try {
            await expect(Worktree.remove({ sessionID: session.id, target: created.id, force: true })).rejects.toThrow(
              "Stop session",
            )
          } finally {
            await SessionManager.release(session.id)
            await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
            await Session.remove(session.id)
          }
        })(),
    })
  })

  test("list includes dirty and diskBytes for managed worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const created = await Worktree.create({
            name: "list-enriched",
            bind: false,
            baseRef: "current",
          })

          const listed = await Worktree.list()
          const managed = listed.find((item) => item.id === created.id)
          expect(managed).toBeDefined()
          expect(managed!.dirty).toBe(false)
          expect(typeof managed!.diskBytes).toBe("number")
          expect(managed!.diskBytes!).toBeGreaterThanOrEqual(0)

          await Worktree.remove({ target: created.id, force: true })
        })(),
    })
  })

  test("POST /experimental/worktree/remove succeeds and migrates bound sessions to main", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const app = Server.App()
          const session1 = await Session.create({ title: "HTTP Remove 1" })
          const session2 = await Session.create({ title: "HTTP Remove 2" })
          const created = await Worktree.create({
            name: "http-remove",
            sessionID: session1.id,
            bind: true,
            baseRef: "current",
          })
          await Worktree.enter({ sessionID: session2.id, target: created.id, force: false })

          const response = await app.request(
            `/experimental/worktree/remove?directory=${encodeURIComponent(scope.worktree)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: created.id, force: true, sessionID: session1.id }),
            },
          )

          expect(response.status).toBe(200)

          const s1 = await Session.get(session1.id)
          const s2 = await Session.get(session2.id)
          expect(s1.workspace?.type).toBe("main")
          expect(s2.workspace?.type).toBe("main")

          const listed = await Worktree.list()
          expect(listed.find((item) => item.id === created.id)).toBeUndefined()

          await Session.remove(session1.id)
          await Session.remove(session2.id)
        })(),
    })
  })

  test("POST /experimental/worktree/remove rejects busy bound sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const app = Server.App()
          const session = await Session.create({ title: "HTTP Busy Remove" })
          const created = await Worktree.create({
            name: "http-busy-remove",
            sessionID: session.id,
            bind: true,
            baseRef: "current",
          })

          SessionManager.registerRuntime(session.id)
          SessionManager.acquire(session.id)

          try {
            const response = await app.request(
              `/experimental/worktree/remove?directory=${encodeURIComponent(scope.worktree)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ target: created.id, force: true, sessionID: session.id }),
              },
            )
            expect(response.status).toBe(400)
            const body = await response.json()
            expect(body.name).toBe("WorktreeSessionBusyError")
          } finally {
            await SessionManager.release(session.id)
            await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
            await Session.remove(session.id)
          }
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
