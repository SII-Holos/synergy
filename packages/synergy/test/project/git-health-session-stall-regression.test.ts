// ---------------------------------------------------------------------------
// git-health-session-stall-regression.test.ts
//
// Regression tests for the GitHealth invalidation behavior that contributed
// to session loop stalls in worktree environments.
//
// Root cause context:
//   1. loop-signals.ts calls GitHealth.invalidate() (global, no args) after
//      every bash command, which bumps _generation and clears _refreshing
//      for ALL directories — not just the current ScopeContext.current.directory.
//   2. This kills in-flight refresh deduplication and discards cache-write
//      results for unrelated directories.
//   3. Combined with Snapshot.track() hanging on git add (no timeout),
//      this creates a stall where the session loop appears "busy" forever.
//
// Contract under test:
//   - invalidate(cwd) MUST only affect the specified directory's cached
//     entries and aliases. It MUST NOT:
//       a) Clear _refreshing entries for other directories (kills dedupe)
//       b) Bump _generation globally (discards in-flight scan cache writes)
//   - invalidate() (no args, global) MAY clear everything, but the
//     git_health_cache_invalidator in loop-signals.ts should be changed
//     to use the scoped form: invalidate(ScopeContext.current.directory).
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"
import { $ } from "bun"

// ---------------------------------------------------------------------------
// Dynamic import
// ---------------------------------------------------------------------------
type GitHealthModule = typeof import("../../src/project/git-health")
let GitHealth: GitHealthModule["GitHealth"]

beforeAll(async () => {
  const mod = await import("../../src/project/git-health")
  GitHealth = mod.GitHealth
})

// ---------------------------------------------------------------------------
// Local Issue interface
// ---------------------------------------------------------------------------
interface Issue {
  dimension:
    | "diff_lines"
    | "diff_files"
    | "untracked"
    | "large_files"
    | "extra_branches"
    | "detached_head"
    | "gc_needed"
  level: "warn" | "critical"
  message: string
  detail: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Git repo fixture helpers
// ---------------------------------------------------------------------------
interface TestRepo {
  path: string
  cleanup: () => void
}

function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(os.tmpdir(), "synergy-test-gh-stall-"))
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function gitInit(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await $`git init`.cwd(dir).quiet()
  await $`git config user.email test@synergy.dev`.cwd(dir).quiet()
  await $`git config user.name "Test Agent"`.cwd(dir).quiet()
}

async function gitEmptyCommit(dir: string, message = "test commit"): Promise<void> {
  await $`git commit --allow-empty -m ${message}`.cwd(dir).quiet()
}

// ===========================================================================
// Test: scoped invalidate preserves other directory's cache
// ===========================================================================

describe("GitHealth.invalidate(cwd) — scoped cache preservation", () => {
  test("invalidate(dirA) does not clear cached results for dirB", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    try {
      // repoA: clean
      await gitInit(repoA.path)
      await gitEmptyCommit(repoA.path, "root")

      // repoB: detached HEAD (creates a detectable issue)
      await gitInit(repoB.path)
      await gitEmptyCommit(repoB.path, "root")
      await $`git checkout --detach`.cwd(repoB.path).quiet()

      // Populate cache for both
      await GitHealth.check(repoA.path)
      await GitHealth.check(repoB.path)

      // Pollute repoA with untracked files (would be detected if re-scanned)
      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repoA.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      // Scoped invalidate on repoA only
      GitHealth.invalidate(repoA.path)

      // repoA: should re-scan and find the new untracked files
      const issuesA = await GitHealth.check(repoA.path)
      const untrackedA = issuesA.find((i: Issue) => i.dimension === "untracked")
      expect(untrackedA, "repoA should detect untracked after scoped invalidate").toBeDefined()

      // repoB: should still have cached result (detached head)
      // If scoped invalidate leaked globally, check(repoB.path) would
      // return cache-missed empty results instead of the cached issues.
      const issuesB = await GitHealth.check(repoB.path)
      const detachedB = issuesB.find((i: Issue) => i.dimension === "detached_head")
      expect(detachedB, "repoB cache should survive scoped invalidate on repoA").toBeDefined()
    } finally {
      repoA.cleanup()
      repoB.cleanup()
      GitHealth.invalidate()
    }
  })
})

// ===========================================================================
// Test: scoped invalidate does not kill in-flight refresh for another dir
// ===========================================================================

describe("GitHealth.invalidate(cwd) — in-flight refresh preservation", () => {
  test("invalidate(dirA) does not prevent inflight refresh on dirB from populating cache", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    try {
      // repoA: clean
      await gitInit(repoA.path)
      await gitEmptyCommit(repoA.path, "root")

      // repoB: detached HEAD so it has detectable issues
      await gitInit(repoB.path)
      await gitEmptyCommit(repoB.path, "root")
      await $`git checkout --detach`.cwd(repoB.path).quiet()

      // Clear state
      GitHealth.invalidate()

      // Start a refresh on repoB and capture the promise
      const refreshB = GitHealth.refresh(repoB.path)

      // Immediately invalidate repoA (scoped)
      GitHealth.invalidate(repoA.path)

      // Wait for repoB refresh to complete
      const issuesB = await refreshB
      expect(issuesB.length, "repoB refresh should complete with issues").toBeGreaterThan(0)

      // After the refresh completes, the cache should be populated.
      // The current implementation bumps _generation in invalidate()
      // even when scoped, which causes the generation check in refresh()
      // to discard the cache write. This is the BUG.
      //
      // Expected RED: injectCached returns undefined because cache
      // was never populated (generation mismatch).
      const cached = GitHealth.injectCached(repoB.path)
      expect(cached, "injectCached should return cached result after refresh completes").toBeDefined()
    } finally {
      repoA.cleanup()
      repoB.cleanup()
      GitHealth.invalidate()
    }
  })

  test("invalidate(dirA) does not break deduplication for concurrent refresh on dirB", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    try {
      await gitInit(repoA.path)
      await gitEmptyCommit(repoA.path, "root")

      await gitInit(repoB.path)
      await gitEmptyCommit(repoB.path, "root")

      GitHealth.invalidate()

      // Start two concurrent refreshes on repoB — second should dedupe
      const first = GitHealth.refresh(repoB.path)
      const second = GitHealth.refresh(repoB.path)
      expect(second, "concurrent refreshes should dedupe").toBe(first)

      // Now invalidate repoA (scoped) while repoB refresh is in-flight
      GitHealth.invalidate(repoA.path)

      // A third concurrent refresh on repoB should STILL dedupe to the
      // original in-flight promise. Currently, invalidate() clears
      // _refreshing globally, so this returns a new, unrelated promise.
      const third = GitHealth.refresh(repoB.path)
      expect(third, "deduplication should survive scoped invalidate on another dir").toBe(first)

      await first
    } finally {
      repoA.cleanup()
      repoB.cleanup()
      GitHealth.invalidate()
    }
  })
})

// ===========================================================================
// Test: global invalidate should allow in-flight refreshes to complete
// ===========================================================================

describe("GitHealth.invalidate() — global invalidation inflight contract", () => {
  test("global invalidate does not discard already-in-flight scan results", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path, "root")

      // Detach HEAD for a detectable issue
      await $`git checkout --detach`.cwd(repo.path).quiet()

      GitHealth.invalidate()

      // Start a refresh
      const refresh = GitHealth.refresh(repo.path)

      // Global invalidate (what loop-signals currently does)
      GitHealth.invalidate()

      // The in-flight refresh should still resolve with the scan results
      const issues = await refresh
      expect(issues.length, "refresh should complete with issues").toBeGreaterThan(0)

      // Whether or not the cache is populated after global invalidate is a
      // design choice. The important invariant is that the promise resolves
      // and the data is not lost.
      const detachedIssue = issues.find((i: Issue) => i.dimension === "detached_head")
      expect(detachedIssue, "detached head should be detected").toBeDefined()
    } finally {
      repo.cleanup()
      GitHealth.invalidate()
    }
  })
})
