// ---------------------------------------------------------------------------
// git-health-scoped-invalidation-contract.test.ts
//
// Tests verifying the scoped-invalidation contract of GitHealth.invalidate(cwd)
// vs. GitHealth.invalidate().
//
// Root cause: the git_health_cache_invalidator in loop-signals.ts calls
// GitHealth.invalidate() with no directory argument. This globally clears
// _cache, _refreshing, and bumps _generation for ALL directories.
//
// In a worktree environment with multiple active sessions in different
// directories (main checkout + worktree), this kills in-flight refresh
// deduplication and discards cache-write results for unrelated directories.
//
// Fix: the invalidator should call GitHealth.invalidate(ScopeContext.current.directory).
//
// This test lives in test/project/ to stay close to the GitHealth module
// and avoid the session import chain (which requires workspace packages
// not installed in worktrees).
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"
import { $ } from "bun"

// ---------------------------------------------------------------------------
// Dynamic import — GitHealth module only, no session chain
// ---------------------------------------------------------------------------
type GitHealthModule = typeof import("../../src/project/git-health")
let GitHealth: GitHealthModule["GitHealth"]
const GIT_HEALTH_TEST_TIMEOUT = 30_000
const gitHealthTest = test.serial

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
  const dir = mkdtempSync(join(os.tmpdir(), "synergy-test-gh-scope-"))
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
// Contract: scoped invalidate(cwd) preserves other directories
// ===========================================================================

describe("GitHealth.invalidate — scoped vs global contract", () => {
  gitHealthTest(
    "invalidate(cwd) clears only the specified directory's cache; other dirs survive",
    async () => {
      const repoA = makeRepo()
      const repoB = makeRepo()
      try {
        // repoA: clean repo
        await gitInit(repoA.path)
        await gitEmptyCommit(repoA.path, "root")

        // repoB: has detectable issues (detached HEAD)
        await gitInit(repoB.path)
        await gitEmptyCommit(repoB.path, "root")
        await $`git checkout --detach`.cwd(repoB.path).quiet()

        // Populate caches for both
        await GitHealth.check(repoA.path)
        await GitHealth.check(repoB.path)

        // Verify repoB is cached (returns without re-scanning)
        const issuesB1 = await GitHealth.check(repoB.path)
        const detachedB1 = issuesB1.find((i: Issue) => i.dimension === "detached_head")
        expect(detachedB1, "detached head should be cached").toBeDefined()

        // Scoped invalidate on repoA only
        GitHealth.invalidate(repoA.path)

        // repoB should STILL return cached result (not re-scanned)
        const issuesB2 = await GitHealth.check(repoB.path)
        const detachedB2 = issuesB2.find((i: Issue) => i.dimension === "detached_head")
        expect(detachedB2, "scoped invalidate on repoA must not clear repoB cache").toBeDefined()

        // repoA should re-scan (cache was cleared)
        // Add files so re-scan detects something different
        for (let i = 1; i <= 50; i++) {
          writeFileSync(join(repoA.path, `untracked-${i}.tmp`), `temp ${i}`)
        }
        const issuesA2 = await GitHealth.check(repoA.path)
        const untrackedA = issuesA2.find((i: Issue) => i.dimension === "untracked")
        expect(untrackedA, "re-scan on repoA should find new untracked files").toBeDefined()
      } finally {
        repoA.cleanup()
        repoB.cleanup()
        GitHealth.invalidate()
      }
    },
    GIT_HEALTH_TEST_TIMEOUT,
  )

  gitHealthTest(
    "invalidate() without cwd clears caches for all directories",
    async () => {
      const repoA = makeRepo()
      const repoB = makeRepo()
      try {
        await gitInit(repoA.path)
        await gitEmptyCommit(repoA.path, "root")

        await gitInit(repoB.path)
        await gitEmptyCommit(repoB.path, "root")
        await $`git checkout --detach`.cwd(repoB.path).quiet()

        // Populate caches
        await GitHealth.check(repoA.path)
        await GitHealth.check(repoB.path)

        // Global invalidate
        GitHealth.invalidate()

        // Both should re-scan now
        for (let i = 1; i <= 50; i++) {
          writeFileSync(join(repoA.path, `untracked-${i}.tmp`), `temp ${i}`)
        }
        const issuesA = await GitHealth.check(repoA.path)
        const untrackedA = issuesA.find((i: Issue) => i.dimension === "untracked")
        expect(untrackedA, "after global invalidate, repoA should re-scan").toBeDefined()

        const issuesB = await GitHealth.check(repoB.path)
        const detachedB = issuesB.find((i: Issue) => i.dimension === "detached_head")
        expect(detachedB, "after global invalidate, repoB should re-scan").toBeDefined()
      } finally {
        repoA.cleanup()
        repoB.cleanup()
        GitHealth.invalidate()
      }
    },
    GIT_HEALTH_TEST_TIMEOUT,
  )
})
