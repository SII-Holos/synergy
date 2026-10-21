import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "../../src/workspace/worktree"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

describe("managed worktree retention", () => {
  test("a released checkout restores once for concurrent requests after Runtime restart", async () => {
    await using home = await tmpdir()
    await using repo = await tmpdir({ git: true })
    const first = await testRuntime({ home: home.path })
    const saved = await first
      .run(async () => {
        const scope = await repo.scope()
        return ScopeContext.provide({
          scope,
          fn: async () => {
            await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(repo.path)
            const session = await Session.create()
            const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
            await Session.update(session.id, (draft) => {
              draft.time.archived = Date.now()
            })
            await Worktree.sweep({ maxManaged: 0 })
            return { session: await Session.get(session.id), tree }
          },
        })
      })
      .finally(() => first.close())
    await using second = await testRuntime({ home: home.path })
    await Promise.all([
      second.run(() => Worktree.prepareSession(saved.session)),
      second.run(() => Worktree.prepareSession(saved.session)),
    ])
    await second.run(async () => {
      const restored = await WorkspaceCatalog.get(saved.session.workspaceID!, saved.session.scope.id)
      expect(restored.lifecycle).toBe("active")
      expect(restored.binding.generation).toBe(saved.session.workspace!.generation! + 1)
      expect(await $`git status --porcelain`.quiet().cwd(saved.tree.path).text()).toBe("")
    })
  }, 20_000)

  test.each(["branch", "path"] as const)(
    "restoration preserves a changed %s and its recovery evidence",
    (changed) =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(tmp.path)
            const session = await Session.create()
            const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
            await Session.update(session.id, (draft) => {
              draft.time.archived = Date.now()
            })
            const before = await Session.get(session.id)
            const head = await $`git rev-parse HEAD`.quiet().cwd(tree.path).text()
            await Worktree.sweep({ maxManaged: 0 })
            if (changed === "branch") {
              await $`git -c user.name=Test -c user.email=test@example.com commit --allow-empty -m changed`
                .quiet()
                .cwd(tmp.path)
              await $`git update-ref ${`refs/heads/${tree.branch}`} HEAD`.quiet().cwd(tmp.path)
            } else {
              await fs.mkdir(tree.path)
              await Bun.write(path.join(tree.path, "new-work.txt"), "preserve this")
            }
            await expect(Worktree.prepareSession(before)).rejects.toBeDefined()
            expect((await WorkspaceCatalog.get(before.workspaceID!, scope.id)).lifecycle).toBe("released")
            expect(await $`git rev-parse ${`refs/synergy/released/${tree.id}`}`.quiet().cwd(tmp.path).text()).toBe(head)
            if (changed === "path")
              expect(await Bun.file(path.join(tree.path, "new-work.txt")).text()).toBe("preserve this")
            await Session.remove(session.id)
          },
        })
      }),
    15_000,
  )

  test.each(["before", "after"] as const)(
    "unarchive racing %s the retirement fence keeps one coherent binding",
    (order) =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.local!.worktree)
            const session = await Session.create()
            const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
            await Session.update(session.id, (draft) => {
              draft.time.archived = Date.now()
            })
            const selected = await Session.get(session.id)
            const entered = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            const retire = WorkspaceAccess.retire
            const begin = WorkspaceCatalog.beginRetirement
            using gate =
              order === "before"
                ? spyOn(WorkspaceAccess, "retire").mockImplementation(async (roots, fn, options) => {
                    entered.resolve()
                    await release.promise
                    return retire(roots, fn, options)
                  })
                : spyOn(WorkspaceCatalog, "beginRetirement").mockImplementation(async (records, recovery) => {
                    const result = await begin(records, recovery)
                    entered.resolve()
                    await release.promise
                    return result
                  })
            const sweep = Worktree.sweep({ maxManaged: 0 })
            await entered.promise
            try {
              const unarchive = Session.update(session.id, (draft) => {
                delete draft.time.archived
              })
              if (order === "before") await unarchive
              else {
                release.resolve()
                await expect(unarchive).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
              }
            } finally {
              release.resolve()
            }
            const report = await sweep
            gate.mockRestore()
            if (order === "before") expect(report.removed).toEqual([])
            else expect(report.removed).toEqual([tree.id])
            await SessionManager.run(session.id, async () => {
              const current = await Session.get(session.id)
              expect(current.workspaceID).toBe(selected.workspaceID)
              expect((await fs.stat(tree.path)).isDirectory()).toBe(true)
              expect((await WorkspaceCatalog.get(selected.workspaceID!, scope.id)).lifecycle).toBe("active")
            })
            await Session.remove(session.id)
          },
        })
      }),
    15_000,
  )

  test("an archived session with durable queued work still protects its checkout", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create()
          const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
          await SessionInbox.enqueueUser({ sessionID: session.id, parts: [{ type: "text", text: "Pending work" }] })
          await Session.update(session.id, (draft) => {
            draft.time.archived = Date.now()
          })
          const report = await Worktree.sweep({ maxManaged: 0 })
          expect(report.removed).toEqual([])
          expect(report.skipped).toContainEqual({ id: tree.id, name: tree.name, reason: "unfinished" })
          expect((await fs.stat(tree.path)).isDirectory()).toBe(true)
          await Session.remove(session.id)
        },
      })
    }))

  test("a retained checkout fenced by an older failed cleanup becomes usable again", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create()
          const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
          const before = await Session.get(session.id)
          const record = await WorkspaceCatalog.get(before.workspaceID!, scope.id)
          await WorkspaceCatalog.beginRetirement([record])
          await Worktree.prepareSession(before)
          expect((await WorkspaceCatalog.get(record.id, scope.id)).lifecycle).toBe("active")
          expect((await Session.get(session.id)).workspaceID).toBe(record.id)
          expect((await fs.stat(tree.path)).isDirectory()).toBe(true)
          await Session.remove(session.id)
        },
      })
    }))

  test.each(["release", "prepare", "restore"] as const)(
    "recovery resumes after interruption at %s publication",
    (phase) =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.local!.worktree)
            const session = await Session.create()
            const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
            await Session.update(session.id, (draft) => {
              draft.time.archived = Date.now()
            })
            const before = await Session.get(session.id)
            if (phase === "release") {
              using failure = spyOn(WorkspaceCatalog, "completeRetirement").mockRejectedValueOnce(
                new Error("interrupted"),
              )
              await Worktree.sweep({ maxManaged: 0 })
              expect((await WorkspaceCatalog.get(before.workspaceID!, scope.id)).lifecycle).toBe("deleting")
            } else {
              await Worktree.sweep({ maxManaged: 0 })
              using failure = spyOn(
                WorkspaceCatalog,
                phase === "prepare" ? "updateRecovery" : "restoreReleased",
              ).mockRejectedValueOnce(new Error("interrupted"))
              await expect(Worktree.prepareSession(before)).rejects.toThrow("interrupted")
              expect((await WorkspaceCatalog.get(before.workspaceID!, scope.id)).lifecycle).toBe("released")
            }
            await Worktree.prepareSession(before)
            expect((await WorkspaceCatalog.get(before.workspaceID!, scope.id)).lifecycle).toBe("active")
            expect(await $`git status --porcelain`.quiet().cwd(tree.path).text()).toBe("")
            expect((await Session.get(session.id)).workspaceID).toBe(before.workspaceID)
            await Session.remove(session.id)
          },
        })
      }),
    15_000,
  )

  test(
    "concurrent release and restore preserve one logical workspace",
    () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.local!.worktree)
            const session = await Session.create()
            const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
            await Session.update(session.id, (draft) => {
              draft.time.archived = Date.now()
            })
            const before = await Session.get(session.id)
            const released = await Promise.all([Worktree.release(tree.id), Worktree.release(tree.id)])
            expect(released).toEqual([{ performed: true }, { performed: true }])
            expect(await fs.stat(tree.path).catch(() => undefined)).toBeUndefined()
            expect((await Session.get(session.id)).workspaceID).toBe(before.workspaceID)
            expect((await WorkspaceCatalog.get(before.workspaceID!, scope.id)).lifecycle).toBe("released")
            await Worktree.sweep({ maxManaged: 0 })
            await Promise.all([Worktree.prepareSession(before), Worktree.prepareSession(before)])
            const restored = await WorkspaceCatalog.get(before.workspaceID!, scope.id)
            expect(restored.lifecycle).toBe("active")
            expect(restored.binding.generation).toBe(before.workspace!.generation! + 1)
            expect((await fs.stat(tree.path)).isDirectory()).toBe(true)
            expect(await $`git status --porcelain`.quiet().cwd(tree.path).text()).toBe("")
            expect((await Session.get(session.id)).workspaceID).toBe(before.workspaceID)
            await Session.remove(session.id)
          },
        })
      }),
    15_000,
  )

  test("an idle unarchived session protects its checkout above the cap", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.local!.worktree)
          const session = await Session.create()
          const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
          const before = await Session.get(session.id)
          const report = await Worktree.sweep({ maxManaged: 0 })
          expect(report.removed).toEqual([])
          expect(report.skipped).toContainEqual({ id: tree.id, name: tree.name, reason: "unarchived" })
          expect((await Session.get(session.id)).workspace).toEqual(before.workspace)
          expect((await fs.stat(tree.path)).isDirectory()).toBe(true)
          await Session.remove(session.id)
        },
      })
    }))

  test(
    "native contention skips cleanup without fencing the retained checkout",
    () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.local!.worktree)
            const session = await Session.create()
            const tree = await Worktree.create({ sessionID: session.id, bind: true, baseRef: "current" })
            await Session.update(session.id, (draft) => {
              draft.time.archived = Date.now()
            })
            const before = await Session.get(session.id)
            const entered = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            const held = WorkspaceAccess.task({ workspace: before.workspace }, () =>
              WorkspaceAccess.write([tree.path], async () => {
                entered.resolve()
                await release.promise
              }),
            )
            await entered.promise
            try {
              const report = await Worktree.sweep({ maxManaged: 0 })
              expect(report.removed).toEqual([])
              expect(report.skipped).toContainEqual({ id: tree.id, name: tree.name, reason: "busy" })
              const current = await WorkspaceCatalog.get(before.workspaceID!, scope.id)
              expect(current.lifecycle).toBe("active")
              expect((await fs.stat(tree.path)).isDirectory()).toBe(true)
            } finally {
              release.resolve()
              await held
              await Session.remove(session.id)
            }
          },
        })
      }),
    15_000,
  )
})
