import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

// ---------------------------------------------------------------------------
// workspace/worktree-lock.test.ts
//
// Lock provenance. A Synergy-written lock must be distinguishable from one a
// user wrote, using git's own porcelain output — which is never translated —
// instead of git's localized stderr. Deciding "already locked" from stderr
// only works under an English locale, and the server does not pin LC_ALL, so a
// zh_CN runtime took the throw path instead of reporting the existing lock and
// left the on-disk lock with no way to clear it.
// ---------------------------------------------------------------------------

const originalLocale = process.env.LC_ALL

afterEach(() =>
  runtime.run(() => {
    if (originalLocale === undefined) delete process.env.LC_ALL
    else process.env.LC_ALL = originalLocale
  }),
)

// git prints the resolved path, which can differ from the created path through
// a symlinked temp root, so key the map by basename.
function lockReasons(porcelain: string): Map<string, string> {
  const owned = new Map<string, string>()
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean)
    const worktree = lines.find((line) => line.startsWith("worktree "))
    if (!worktree) continue
    const locked = lines.find((line) => line === "locked" || line.startsWith("locked "))
    if (locked === undefined) continue
    owned.set(path.basename(worktree.slice("worktree ".length)), locked.slice("locked".length).trim())
  }
  return owned
}

async function porcelain(cwd: string) {
  const text = await $`git worktree list --porcelain`.quiet().cwd(cwd).text()
  return lockReasons(text)
}

describe("worktree lock provenance", () => {
  test("parses locked and prunable tokens without storing translated text", () =>
    runtime.run(() => {
      const entries = Worktree.parsePorcelain(
        [
          "worktree /repo",
          "HEAD abc",
          "branch refs/heads/dev",
          "",
          "worktree /repo/one",
          "HEAD def",
          "branch refs/heads/one",
          "locked synergy:v1:session=ses_abc",
          "",
          "worktree /repo/two",
          "HEAD 123",
          "detached",
          "locked",
          "prunable gitdir file points to non-existent location",
          "",
        ].join("\n"),
      )

      expect(entries[0].locked).toBeUndefined()
      expect(entries[0].prunable).toBeUndefined()
      expect(entries[1].locked).toBe("synergy:v1:session=ses_abc")
      expect(entries[2].locked).toBe("")
      // Only presence is recorded: git translates this value, the key is stable.
      expect(entries[2].prunable).toBe(true)
    }))

  test("writes a Synergy marker that git reports in porcelain", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await Worktree.create({ name: "lock-marker", bind: false, baseRef: "current" })
          const key = path.basename(created.path)

          const result = await Worktree.lock(created.path, "ses_marker000000000000")
          expect(result.acquired).toBe(true)
          expect((await porcelain(scope.local!.worktree)).get(key)).toBe("synergy:v1:session=ses_marker000000000000")

          await Worktree.unlock(created.path)
          expect((await porcelain(scope.local!.worktree)).get(key)).toBeUndefined()

          await Worktree.remove({ target: created.id, force: true })
        },
      })
    }))

  test("reports an existing foreign lock under a non-English locale", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await Worktree.create({ name: "lock-locale", bind: false, baseRef: "current" })
          const key = path.basename(created.path)

          // A lock this process did not write, with no reason at all.
          await $`git worktree lock ${created.path}`.quiet().cwd(scope.local!.worktree)
          process.env.LC_ALL = "zh_CN.UTF-8"

          const result = await Worktree.lock(created.path)
          expect(result.acquired).toBe(false)
          expect(result.existing).toBe(true)

          // A lock Synergy did not write must survive the paired release.
          await Worktree.unlock(created.path)
          expect((await porcelain(scope.local!.worktree)).get(key)).toBe("")

          await $`git worktree unlock ${created.path}`.quiet().cwd(scope.local!.worktree)
          await Worktree.remove({ target: created.id, force: true })
        },
      })
    }))

  test("only releases a Synergy lock acquired by this process", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await Worktree.create({ name: "lock-reclaim", bind: false, baseRef: "current" })
          const key = path.basename(created.path)

          await $`git worktree lock --reason synergy:v1:session=ses_stale00000000000 ${created.path}`
            .quiet()
            .cwd(scope.local!.worktree)
          expect(await Worktree.releaseLockForRemoval(created.path)).toBe(false)
          await $`git worktree unlock ${created.path}`.quiet().cwd(scope.local!.worktree)
          await Worktree.lock(created.path)
          expect(await Worktree.releaseLockForRemoval(created.path)).toBe(true)
          await Worktree.unlock(created.path)
          expect((await porcelain(scope.local!.worktree)).get(key)).toBeUndefined()

          await $`git worktree lock ${created.path}`.quiet().cwd(scope.local!.worktree)
          expect(await Worktree.releaseLockForRemoval(created.path)).toBe(false)
          expect((await porcelain(scope.local!.worktree)).get(key)).toBe("")

          await $`git worktree unlock ${created.path}`.quiet().cwd(scope.local!.worktree)
          await Worktree.remove({ target: created.id, force: true })
        },
      })
    }))

  test("unlock never throws when this process holds no lock state", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await Worktree.create({ name: "lock-noop", bind: false, baseRef: "current" })

          await Worktree.unlock(created.path)
          await $`git worktree unlock ${created.path}`.quiet().nothrow().cwd(scope.local!.worktree)
          await Worktree.remove({ target: created.id, force: true })
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
