import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionNav } from "@ericsanchezok/synergy-harness/session/nav"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Worktree } from "@ericsanchezok/synergy-runtime-local/workspace/worktree"

// ---------------------------------------------------------------------------
// workspace/worktree-janitor.test.ts
//
// The managed-worktree reaper. Every guard it applies protects against an
// irreversible loss — unpushed commits, a lock a user wrote by hand, the
// directory a running session is executing in — so these tests drive real git
// repositories and assert on the resulting disk state rather than mocking git.
// `maxManaged` is injected as 0 or 1 wherever a guard is under test: with a
// small cap the removal budget always exceeds the eligible set, so a guard that
// failed to hold would destroy the worktree instead of merely going unnoticed.
// ---------------------------------------------------------------------------

async function exists(target: string) {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false)
}

function registryFile(repoRoot: string, id: string) {
  return path.join(repoRoot, ".synergy", "worktrees", ".registry", `${id}.json`)
}

async function setLastUsedAt(repoRoot: string, id: string, lastUsedAt: number) {
  const file = registryFile(repoRoot, id)
  const parsed = JSON.parse(await Bun.file(file).text())
  await Bun.write(file, JSON.stringify({ ...parsed, lastUsedAt }, null, 2))
}

async function branchExists(cwd: string, branch: string) {
  const result = await $`git rev-parse --verify --quiet refs/heads/${branch}`.quiet().nothrow().cwd(cwd)
  return result.exitCode === 0
}

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

async function porcelainLocks(cwd: string) {
  const text = await $`git worktree list --porcelain`.quiet().cwd(cwd).text()
  return lockReasons(text)
}

function managedInfo(overrides: Partial<Worktree.Info> = {}): Worktree.Info {
  return {
    id: "wt_jani000000000000",
    name: "synergy-janitor",
    path: "/repo/.synergy/worktrees/synergy-janitor",
    scopeID: "scope_janitor",
    managed: true,
    ...overrides,
  }
}

function sweepEvidence(overrides: Partial<Worktree.SweepEvidence> = {}): Worktree.SweepEvidence {
  return { lock: "none", dirty: false, running: false, localOnlyCommits: 0, ...overrides }
}

describe("worktree sweep", () => {
  test("reconciles a managed registration whose directory was deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "reconcile-missing", bind: false, baseRef: "current" })
        await fs.rm(created.path, { recursive: true, force: true })

        // A deleted directory is still listed by git, but marked `prunable`
        // because its gitdir is gone. That is enough to reconcile on this tick:
        // the directory check confirms nothing is left to lose before the
        // registration and its git metadata are dropped together.
        const report = await Worktree.sweep()
        expect(report.reconciled).toContain(created.id)
        expect(report.removed).toEqual([])
        expect(report.skipped.some((item) => item.id === created.id)).toBe(false)

        expect(await Bun.file(registryFile(scope.worktree, created.id)).exists()).toBe(false)
        expect((await Worktree.list()).some((item) => item.id === created.id)).toBe(false)
      },
    })
  })

  test("reconciles a registration whose git metadata was already pruned", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "reconcile-pruned", bind: false, baseRef: "current" })
        await fs.rm(created.path, { recursive: true, force: true })
        await $`git worktree prune`.quiet().cwd(scope.worktree)

        const report = await Worktree.sweep()

        expect(report.reconciled).toContain(created.id)
        expect(report.removed).toEqual([])
        expect(await Bun.file(registryFile(scope.worktree, created.id)).exists()).toBe(false)
        expect(await exists(created.path)).toBe(false)
      },
    })
  })

  test("skips a worktree with uncommitted changes instead of removing it", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "janitor-dirty", bind: false, baseRef: "current" })
        await fs.writeFile(path.join(created.path, "wip.txt"), "uncommitted work\n")

        const report = await Worktree.sweep({ maxManaged: 0 })

        expect(report.skipped).toContainEqual({ id: created.id, name: created.name, reason: "dirty" })
        expect(report.removed).toEqual([])
        expect(await exists(created.path)).toBe(true)
        expect(await Bun.file(registryFile(scope.worktree, created.id)).exists()).toBe(true)
      },
    })
  })

  test("never clears a user lock written without a reason", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "janitor-foreign", bind: false, baseRef: "current" })
        await $`git worktree lock ${created.path}`.quiet().cwd(scope.worktree)

        const report = await Worktree.sweep({ maxManaged: 0 })

        expect(report.skipped).toContainEqual({ id: created.id, name: created.name, reason: "foreign_lock" })
        expect(report.removed).toEqual([])
        expect(await exists(created.path)).toBe(true)
        expect((await porcelainLocks(scope.worktree)).get(path.basename(created.path))).toBe("")
      },
    })
  })

  test("preserves a user lock reason written by hand", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "janitor-foreign-reason", bind: false, baseRef: "current" })
        await $`git worktree lock --reason pinned-for-review ${created.path}`.quiet().cwd(scope.worktree)

        const report = await Worktree.sweep({ maxManaged: 0 })

        expect(report.skipped).toContainEqual({ id: created.id, name: created.name, reason: "foreign_lock" })
        expect(report.removed).toEqual([])
        expect((await porcelainLocks(scope.worktree)).get(path.basename(created.path))).toBe("pinned-for-review")
        expect(await exists(created.path)).toBe(true)
      },
    })
  })

  test("keeps an unverified Synergy lock above the cap", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "janitor-stale-lock", bind: false, baseRef: "current" })
        await $`git worktree lock --reason synergy:v1:session=ses_stale00000000000 ${created.path}`
          .quiet()
          .cwd(scope.worktree)

        const report = await Worktree.sweep({ maxManaged: 0 })

        expect(report.removed).toEqual([])
        expect(report.skipped).toContainEqual({ id: created.id, name: created.name, reason: "synergy_lock" })
        expect(await exists(created.path)).toBe(true)
        expect(await Bun.file(registryFile(scope.worktree, created.id)).exists()).toBe(true)
        expect((await porcelainLocks(scope.worktree)).get(path.basename(created.path))).toContain("synergy:v1:")
      },
    })
  })

  test("skips a worktree whose bound session is running", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Janitor Running Session" })
        const created = await Worktree.create({
          name: "janitor-running",
          sessionID: session.id,
          bind: true,
          baseRef: "current",
        })

        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        expect(SessionManager.isRunning(session.id)).toBe(true)

        try {
          const report = await Worktree.sweep({ maxManaged: 0 })

          expect(report.skipped).toContainEqual({ id: created.id, name: created.name, reason: "running" })
          expect(report.removed).toEqual([])
          expect(await exists(created.path)).toBe(true)
        } finally {
          await SessionManager.release(lease!)
          await Worktree.remove({ sessionID: session.id, target: created.id, force: true })
          await Session.remove(session.id)
        }
      },
    })
  })

  test("skips a worktree holding commits that are missing from the remote", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        // `localOnlyCommitCount` is gated on remote-tracking refs existing, so
        // the remote has to be real for this guard to be reachable at all.
        const origin = path.join(path.dirname(tmp.path), `janitor-origin-${path.basename(tmp.path)}.git`)
        await $`git init --bare -q ${origin}`.quiet().nothrow()
        await $`git remote add origin ${origin}`.quiet().nothrow().cwd(scope.worktree)
        await $`git push -q origin HEAD`.quiet().nothrow().cwd(scope.worktree)
        await $`git fetch -q origin`.quiet().nothrow().cwd(scope.worktree)

        const created = await Worktree.create({ name: "janitor-local-only", bind: false, baseRef: "current" })
        expect((await $`git for-each-ref --count=1 refs/remotes/`.quiet().cwd(created.path).text()).trim()).not.toBe("")
        await $`git commit -q --allow-empty --no-gpg-sign -m "unpushed work"`.quiet().cwd(created.path)

        const report = await Worktree.sweep({ maxManaged: 0 })

        expect(report.skipped).toContainEqual({ id: created.id, name: created.name, reason: "local_only_commits" })
        expect(report.removed).toEqual([])
        expect(await exists(created.path)).toBe(true)
      },
    })
  })

  test("removes the oldest worktrees first when above the cap", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Distinct, deterministic recency: creation alone can share a
        // millisecond, which would make the removal order arbitrary.
        await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.worktree)
        const oldest = await Worktree.create({ name: "janitor-cap-oldest", bind: false, baseRef: "current" })
        const middle = await Worktree.create({ name: "janitor-cap-middle", bind: false, baseRef: "current" })
        const newest = await Worktree.create({ name: "janitor-cap-newest", bind: false, baseRef: "current" })
        await setLastUsedAt(scope.worktree, oldest.id, 1_000)
        await setLastUsedAt(scope.worktree, middle.id, 2_000)
        await setLastUsedAt(scope.worktree, newest.id, 3_000)
        const managed = (await Worktree.list()).filter((item) => item.managed)
        expect(managed).toHaveLength(3)

        const report = await Worktree.sweep({ maxManaged: 1 })

        expect(report.maxManaged).toBe(1)
        expect(report.removed).toHaveLength(managed.length - 1)
        expect(new Set(report.removed)).toEqual(new Set([oldest.id, middle.id]))
        expect(report.skipped).toEqual([])
        expect(await exists(oldest.path)).toBe(false)
        expect(await exists(middle.path)).toBe(false)
        expect(await exists(newest.path)).toBe(true)
        expect(await Bun.file(registryFile(scope.worktree, newest.id)).exists()).toBe(true)
      },
    })
  })

  test.each(["cap", "missing"])("preserves session recency during %s cleanup", async (mode) => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.worktree)
        const older = await Session.create({ title: "Old work" })
        const created = await Worktree.create({ name: "old-work", sessionID: older.id, bind: true, baseRef: "current" })
        const newer = await Session.create({ title: "Recent work" })
        const before = await SessionNav.readNavIndex(scope.id)
        const activity = before.entries.find((entry) => entry.id === older.id)!.lastActivityAt
        if (mode === "missing") await fs.rm(created.path, { recursive: true, force: true })
        const report = await Worktree.sweep({ maxManaged: 0 })
        expect([...report.removed, ...report.reconciled]).toContain(created.id)
        expect((await Session.get(older.id)).workspace?.type).toBe("main")
        const after = await SessionNav.readNavIndex(scope.id)
        expect(after.entries.find((entry) => entry.id === older.id)?.lastActivityAt).toBe(activity)
        expect(after.entries.map((entry) => entry.id)).toEqual(before.entries.map((entry) => entry.id))
        await Session.recordActivity(older.id)
        expect((await SessionNav.readNavIndex(scope.id)).entries[0].id).toBe(older.id)
        await Session.remove(older.id)
        await Session.remove(newer.id)
      },
    })
  })

  test("reports blocked worktrees rather than removing extra work to reach the cap", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await $`git update-ref refs/remotes/origin/main HEAD`.quiet().cwd(scope.worktree)
        const blocked = await Worktree.create({ name: "janitor-budget-dirty", bind: false, baseRef: "current" })
        const reclaimable = await Worktree.create({ name: "janitor-budget-clean", bind: false, baseRef: "current" })
        await fs.writeFile(path.join(blocked.path, "wip.txt"), "uncommitted work\n")

        // The removal budget (2) exceeds the eligible set (1). The sweep must
        // spend only what it is allowed to and report the rest.
        const report = await Worktree.sweep({ maxManaged: 0 })

        expect(report.removed).toEqual([reclaimable.id])
        expect(report.skipped).toContainEqual({ id: blocked.id, name: blocked.name, reason: "dirty" })
        expect(await exists(blocked.path)).toBe(true)
        expect(await exists(reclaimable.path)).toBe(false)
      },
    })
  })
})

describe("worktree sweep eligibility", () => {
  test("keeps an unmanaged worktree as external", () => {
    expect(
      Worktree.decide(
        managedInfo({ managed: false, isMain: true }),
        sweepEvidence({ lock: "foreign", dirty: true, running: true, localOnlyCommits: 3 }),
      ),
    ).toEqual({ eligible: false, reason: "external" })
  })

  test("keeps the main worktree", () => {
    expect(
      Worktree.decide(
        managedInfo({ isMain: true }),
        sweepEvidence({ lock: "foreign", dirty: true, running: true, localOnlyCommits: 3 }),
      ),
    ).toEqual({ eligible: false, reason: "main" })
  })

  test("keeps a worktree locked outside Synergy", () => {
    expect(
      Worktree.decide(
        managedInfo(),
        sweepEvidence({ lock: "foreign", dirty: true, running: true, localOnlyCommits: 3 }),
      ),
    ).toEqual({ eligible: false, reason: "foreign_lock" })
  })

  test("keeps a worktree with a running bound session", () => {
    expect(Worktree.decide(managedInfo(), sweepEvidence({ running: true, dirty: true, localOnlyCommits: 3 }))).toEqual({
      eligible: false,
      reason: "running",
    })
  })

  test("keeps a dirty worktree", () => {
    expect(Worktree.decide(managedInfo(), sweepEvidence({ dirty: true, localOnlyCommits: 3 }))).toEqual({
      eligible: false,
      reason: "dirty",
    })
  })

  test("keeps a worktree whose dirtiness could not be determined", () => {
    expect(Worktree.decide(managedInfo(), sweepEvidence({ dirty: undefined, localOnlyCommits: 3 }))).toEqual({
      eligible: false,
      reason: "unknown_dirty",
    })
  })

  test("keeps a worktree whose commits are missing from the remote", () => {
    expect(Worktree.decide(managedInfo(), sweepEvidence({ localOnlyCommits: 1 }))).toEqual({
      eligible: false,
      reason: "local_only_commits",
    })
  })

  test("reclaims a clean, unlocked, idle worktree", () => {
    expect(Worktree.decide(managedInfo(), sweepEvidence())).toEqual({ eligible: true })
    expect(Worktree.decide(managedInfo(), sweepEvidence({ lock: "synergy" }))).toEqual({
      eligible: false,
      reason: "synergy_lock",
    })
  })
})

describe("worktree branch cleanup", () => {
  test("deletes the branch when its content landed through a squash merge", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "branch-landed", bind: false, baseRef: "current" })
        await Bun.write(path.join(created.path, "landed.txt"), "landed content\n")
        await $`git add .`.quiet().cwd(created.path)
        await $`git commit -qm "landed work"`.quiet().cwd(created.path)

        // Squash it: the trees match, but the branch tip is not an ancestor of
        // the target, so reachability checks cannot see that it landed.
        await $`git merge --squash ${created.branch!}`.quiet().cwd(scope.worktree)
        await $`git commit -qm "squash landed work"`.quiet().cwd(scope.worktree)

        await Worktree.remove({ target: created.id, force: true })

        expect(await branchExists(scope.worktree, created.branch!)).toBe(false)
      },
    })
  })

  test("deletes the branch when a squash landed and the target advanced since", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "branch-squash-advanced", bind: false, baseRef: "current" })
        await Bun.write(path.join(created.path, "squashed.txt"), "squashed content\n")
        await $`git add .`.quiet().cwd(created.path)
        await $`git commit -qm "work to squash"`.quiet().cwd(created.path)

        await $`git merge --squash ${created.branch!}`.quiet().cwd(scope.worktree)
        await $`git commit -qm "squash landed work"`.quiet().cwd(scope.worktree)
        // A later commit breaks tree equality, so only the aggregate patch-id
        // proof is left to recognise the branch as landed.
        await Bun.write(path.join(scope.worktree, "later.txt"), "later work\n")
        await $`git add .`.quiet().cwd(scope.worktree)
        await $`git commit -qm "later target work"`.quiet().cwd(scope.worktree)

        await Worktree.remove({ target: created.id, force: true })

        expect(await branchExists(scope.worktree, created.branch!)).toBe(false)
      },
    })
  })

  test("keeps the branch when its commits never landed anywhere", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const created = await Worktree.create({ name: "branch-unlanded", bind: false, baseRef: "current" })
        await Bun.write(path.join(created.path, "unique.txt"), "work that exists only here\n")
        await $`git add .`.quiet().cwd(created.path)
        await $`git commit -qm "unlanded work"`.quiet().cwd(created.path)

        await Worktree.remove({ target: created.id, force: true })

        // The branch ref is the only surviving copy of this commit, so deleting
        // it would lose the work. Nothing is proven landed => keep it.
        expect(await branchExists(scope.worktree, created.branch!)).toBe(true)
      },
    })
  })
})
