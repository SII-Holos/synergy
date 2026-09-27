import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import {
  requestScopeSweep,
  startWorktreeJanitor,
  stopWorktreeJanitor,
} from "@ericsanchezok/synergy-workbench/project/worktree-janitor"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
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
