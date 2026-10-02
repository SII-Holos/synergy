import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { $ } from "bun"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import {
  requestScopeSweep,
  startWorktreeJanitor,
  stopWorktreeJanitor,
} from "@ericsanchezok/synergy-workbench/project/worktree-janitor"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ProjectDirectories } from "../../src/project/directories"
const runtime = await testRuntime()

// ---------------------------------------------------------------------------
// project/worktree-janitor.test.ts
//
// Janitor wiring: when a sweep may run, and when it must not.
//
// `Worktree.setSweepRequester` installs the request hook process-wide, so the
// first scope that starts a janitor arms the hook for every scope. Without an
// explicit "does this scope have a janitor" check, a worktree creation in an
// unrelated scope runs a background sweep that scope never asked for — and a
// sweep cancels registrations, so it can remove one the caller is still using.
// That regression is what these tests pin.
//
// Reconciliation is cap-independent, so nothing here needs configuration: a
// managed worktree whose directory has vanished is reconciled by the next
// sweep regardless of `maxManaged`.
// ---------------------------------------------------------------------------

function registryFile(repoRoot: string, id: string) {
  return path.join(repoRoot, ".synergy", "worktrees", ".registry", `${id}.json`)
}

function asProject(scope: Scope): Scope.Project {
  if (scope.type !== "project") throw new Error(`expected a project scope, received ${scope.type}`)
  return scope
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await Bun.sleep(50)
  }
  return false
}

describe("worktree janitor wiring", () => {
  test(
    "sweeps current and historical repositories while retaining dirty task bindings",
    () =>
      runtime.run(async () => {
        await using oldRepository = await tmpdir({ git: true })
        await using newRepository = await tmpdir({ git: true })
        await $`git update-ref refs/remotes/origin/main HEAD`.cwd(oldRepository.path).quiet()
        await $`git update-ref refs/remotes/origin/main HEAD`.cwd(newRepository.path).quiet()
        await Config.domainUpdate("worktree", { worktree: { maxManaged: 1 } })
        const project = await ProjectDirectories.create({
          name: "Historical repository cleanup",
          directories: [oldRepository.path],
          mainDirectory: oldRepository.path,
        })
        await ScopeContext.provide({
          scope: project.scope,
          workspace: null,
          fn: async () => {
            const sourceWorkspaceID = project.directories.mainWorkspaceID!
            const session = await Session.create({
              workspace: WorkspaceCatalog.projection(await WorkspaceCatalog.get(sourceWorkspaceID, project.scope.id)),
            })
            const retained = await Worktree.create({
              name: "dirty-historical-task",
              sourceWorkspaceID,
              sessionID: session.id,
              bind: true,
              baseRef: "current",
            })
            const bytes = new Uint8Array([0, 255, 17, 128])
            const dirtyFile = path.join(retained.path, "unsaved.bin")
            await Bun.write(dirtyFile, bytes)
            const historical = await Worktree.create({
              name: "clean-historical-task",
              sourceWorkspaceID,
              bind: false,
              baseRef: "current",
            })
            const changed = await ProjectDirectories.update(project.scope.id, {
              revision: project.directories.revision,
              directories: [newRepository.path],
              mainDirectory: newRepository.path,
            })
            const current = await Worktree.create({
              name: "old-current-task",
              sourceWorkspaceID: changed.mainWorkspaceID!,
              bind: false,
              baseRef: "current",
            })
            const newest = await Worktree.create({
              name: "new-current-task",
              sourceWorkspaceID: changed.mainWorkspaceID!,
              bind: false,
              baseRef: "current",
            })
            const before = await Session.get(session.id)
            await startWorktreeJanitor(project.scope)
            try {
              expect(
                await pollUntil(async () => {
                  const paths = await Promise.all(
                    [historical, current].map((tree) => Bun.file(`${tree.path}/.git`).exists()),
                  )
                  return paths.every((exists) => !exists)
                }),
              ).toBe(true)
            } finally {
              await stopWorktreeJanitor(project.scope.id)
            }
            expect(new Uint8Array(await Bun.file(dirtyFile).arrayBuffer())).toEqual(bytes)
            expect((await Session.get(session.id)).workspace).toEqual(before.workspace)
            expect((await Worktree.resolve(retained.id)).bindings).toContain(session.id)
            expect(await Bun.file(`${newest.path}/.git`).exists()).toBe(true)
            expect((await ProjectDirectories.get(project.scope.id)).folders.map((folder) => folder.path)).toEqual([
              newRepository.path,
            ])
            await Session.remove(session.id)
          },
        })
      }),
    30_000,
  )

  test("scope disposal waits for the active sweep and rejects follow-up requests", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = asProject(await tmp.scope())
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let count = 0
      using sweep = spyOn(Worktree, "sweep").mockImplementation(async () => {
        count++
        entered.resolve()
        await release.promise
        return { scanned: 0, maxManaged: 20, removed: [], skipped: [], reconciled: [] }
      })
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await startWorktreeJanitor(scope)
          requestScopeSweep(scope)
          await entered.promise
          let stopped = false
          const stopping = Promise.resolve(stopWorktreeJanitor(scope.id)).then(() => {
            stopped = true
          })
          try {
            await Promise.resolve()
            expect(stopped).toBe(false)
            requestScopeSweep(scope)
            expect(count).toBe(1)
          } finally {
            release.resolve()
            await stopping
          }
        },
      })
    }))
  test("does not sweep for a scope that never started a janitor", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = asProject(await tmp.scope())

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await Worktree.create({ name: "no-janitor", bind: false, baseRef: "current" })
          await fs.rm(created.path, { recursive: true, force: true })

          // No janitor was started for this scope, so a creation-triggered request
          // must be a no-op rather than a sweep of a scope that never opted in.
          requestScopeSweep(scope)
          await Bun.sleep(500)

          expect(await Bun.file(registryFile(scope.local!.worktree, created.id)).exists()).toBe(true)
        },
      })
    }))

  test("reconciles on the first scheduled sweep once a janitor is started", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = asProject(await tmp.scope())

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await Worktree.create({ name: "has-janitor", bind: false, baseRef: "current" })
          await fs.rm(created.path, { recursive: true, force: true })

          await startWorktreeJanitor(scope)
          try {
            expect(
              await pollUntil(async () => !(await Bun.file(registryFile(scope.local!.worktree, created.id)).exists())),
            ).toBe(true)
          } finally {
            await stopWorktreeJanitor(scope.id)
          }
        },
      })
    }))

  test("stopping a janitor that was never started stays a no-op", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = asProject(await tmp.scope())

      // Idempotent and safe for an unknown scope: disposal must not throw for a
      // scope whose startup never reached the janitor.
      await stopWorktreeJanitor(scope.id)
      await stopWorktreeJanitor(scope.id)

      await ScopeContext.provide({
        scope,
        fn: async () => {
          requestScopeSweep(scope)
          await Bun.sleep(200)
          expect(true).toBe(true)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
