// ---------------------------------------------------------------------------
// git-health.test.ts
//
// Tests for GitHealth — repository health diagnostics.
//
// Contract:
//   export namespace GitHealth {
//     interface Issue {
//       dimension: "diff_lines" | "diff_files" | "untracked" | "large_files"
//                 | "extra_branches" | "detached_head" | "gc_needed"
//       level: "warn" | "critical"
//       message: string
//       detail: Record<string, unknown>
//     }
//     export async function check(cwd?: string): Promise<Issue[]>
//     export async function inject(cwd?: string): Promise<string | undefined>
//     export function refresh(cwd?: string): Promise<Issue[]>
//     export function injectCached(cwd?: string): string | undefined
//     export function lastReport(): Issue[] | undefined
//     export function invalidate(): void
//   }
// ---------------------------------------------------------------------------

import { $ } from "bun"
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// Dynamic import — the module does not exist yet (RED phase).
// Once src/project/git-health.ts is created, this import will succeed.
// The test file will fail at import time until then — that is expected TDD.
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
// Local Issue interface matching the contract for type-safe test assertions.
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

const VALID_DIMENSIONS: Issue["dimension"][] = [
  "diff_lines",
  "diff_files",
  "untracked",
  "large_files",
  "extra_branches",
  "detached_head",
  "gc_needed",
]
const VALID_LEVELS: Issue["level"][] = ["warn", "critical"]

// ---------------------------------------------------------------------------
// Fixture helpers — create temp git repos for each test.
// ---------------------------------------------------------------------------
interface TestRepo {
  path: string
  cleanup: () => void
}

function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(os.tmpdir(), "synergy-test-git-health-"))
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
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

async function gitCommit(dir: string, message = "test commit"): Promise<void> {
  await $`git add -A`.cwd(dir).quiet()
  await $`git commit -m ${message}`.cwd(dir).quiet()
}

// ---------------------------------------------------------------------------
// Matcher to check string belongs to a union of literal types.
// The base expect types are strict; we cast through unknown to avoid fighting
// the type system on dynamically loaded modules.
function expectValidIssue(issue: unknown): void {
  expect(issue).toBeObject()
  const i = issue as Record<string, unknown>
  expect(i.dimension, "dimension").toBeString()
  expect(VALID_DIMENSIONS as string[]).toContain(i.dimension as string)
  expect(i.level, "level").toBeString()
  expect(VALID_LEVELS as string[]).toContain(i.level as string)
  expect(i.message, "message").toBeString()
  expect(i.detail, "detail").toBeObject()
}

// ===========================================================================
// Test suites
// ===========================================================================

describe("GitHealth.check — non-git directory", () => {
  gitHealthTest("returns empty array for a plain directory (no .git)", async () => {
    const repo = makeRepo()
    try {
      const issues = await GitHealth.check(repo.path)
      expect(issues).toBeArray()
      expect(issues).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("returns empty array for a directory that does not exist", async () => {
    const issues = await GitHealth.check("/tmp/does-not-exist-git-health-test")
    expect(issues).toBeArray()
    expect(issues).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — clean repo", () => {
  gitHealthTest("returns empty array or info-level issues only for a fresh repo", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      const issues = await GitHealth.check(repo.path)
      expect(issues).toBeArray()

      const warningsOrWorse = issues.filter((i: Issue) => i.level === "warn" || i.level === "critical")
      expect(warningsOrWorse).toHaveLength(0)
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — dirty working tree, many changed lines", () => {
  gitHealthTest("detects diff_lines issue when a tracked file has 300+ changed lines", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)

      // Create a file with 10 lines, commit it
      const filePath = join(repo.path, "big-diff.txt")
      const initial = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
      writeFileSync(filePath, initial)
      await gitCommit(repo.path)

      // Now rewrite with 310 different lines
      const modified = Array.from({ length: 310 }, (_, i) => `modified line ${i + 1}`).join("\n")
      writeFileSync(filePath, modified)

      const issues = await GitHealth.check(repo.path)
      const diffLinesIssue = issues.find((i: Issue) => i.dimension === "diff_lines")
      expect(diffLinesIssue).toBeDefined()
      expectValidIssue(diffLinesIssue)
      expect(diffLinesIssue!.level).toBeOneOf(["warn", "critical"])
      expect(diffLinesIssue!.message.length).toBeGreaterThan(0)
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — dirty working tree, many changed files", () => {
  gitHealthTest("detects diff_files issue when 30+ files are modified", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)

      // Create and commit 30 files
      for (let i = 1; i <= 30; i++) {
        writeFileSync(join(repo.path, `file-${i}.txt`), `original content ${i}`)
      }
      await gitCommit(repo.path)

      // Modify all 30 files
      for (let i = 1; i <= 30; i++) {
        writeFileSync(join(repo.path, `file-${i}.txt`), `modified content ${i} — changed`)
      }

      const issues = await GitHealth.check(repo.path)
      const diffFilesIssue = issues.find((i: Issue) => i.dimension === "diff_files")
      expect(diffFilesIssue).toBeDefined()
      expectValidIssue(diffFilesIssue)
      expect(diffFilesIssue!.level).toBeOneOf(["warn", "critical"])
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("does not flag diff_files for under 10 modified files", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)

      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(repo.path, `file-${i}.txt`), `original ${i}`)
      }
      await gitCommit(repo.path)

      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(repo.path, `file-${i}.txt`), `changed ${i}`)
      }

      const issues = await GitHealth.check(repo.path)
      const diffFilesIssue = issues.find((i: Issue) => i.dimension === "diff_files")
      expect(diffFilesIssue).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — many untracked files", () => {
  gitHealthTest("detects untracked issue when 50+ untracked files exist", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp content ${i}`)
      }

      const issues = await GitHealth.check(repo.path)
      const untrackedIssue = issues.find((i: Issue) => i.dimension === "untracked")
      expect(untrackedIssue).toBeDefined()
      expectValidIssue(untrackedIssue)
      expect(untrackedIssue!.level).toBeOneOf(["warn", "critical"])
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("does not flag untracked for a small number of untracked files", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      const issues = await GitHealth.check(repo.path)
      const untrackedIssue = issues.find((i: Issue) => i.dimension === "untracked")
      expect(untrackedIssue).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — large tracked file", () => {
  gitHealthTest("detects large_files issue when a tracked file exceeds the size threshold", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)

      // Create a ~15 MB file using direct fd writes
      const bigFilePath = join(repo.path, "big.bin")
      const chunk = Buffer.alloc(1024 * 1024, "x") // 1 MB chunk
      const fd = openSync(bigFilePath, "w")
      for (let i = 0; i < 15; i++) {
        writeSync(fd, chunk)
      }
      closeSync(fd)

      await gitCommit(repo.path)

      const issues = await GitHealth.check(repo.path)
      const largeFileIssue = issues.find((i: Issue) => i.dimension === "large_files")
      expect(largeFileIssue).toBeDefined()
      expectValidIssue(largeFileIssue)
      expect(largeFileIssue!.level).toBeOneOf(["warn", "critical"])
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("does not flag large_files for small tracked files", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)

      writeFileSync(join(repo.path, "small.txt"), "hello world")
      await gitCommit(repo.path)

      const issues = await GitHealth.check(repo.path)
      const largeFileIssue = issues.find((i: Issue) => i.dimension === "large_files")
      expect(largeFileIssue).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — extra branches", () => {
  gitHealthTest(
    "detects extra_branches issue when 25+ extra branches exist",
    async () => {
      const repo = makeRepo()
      try {
        await gitInit(repo.path)
        await gitEmptyCommit(repo.path, "root")

        // Create 25 branches pointing at the same root commit
        for (let i = 1; i <= 25; i++) {
          await $`git branch stale-branch-${i}`.cwd(repo.path).quiet()
        }

        const issues = await GitHealth.check(repo.path)
        const extraBranchesIssue = issues.find((i: Issue) => i.dimension === "extra_branches")
        expect(extraBranchesIssue).toBeDefined()
        expectValidIssue(extraBranchesIssue)
        expect(extraBranchesIssue!.level).toBeOneOf(["warn", "critical"])
        expect(extraBranchesIssue!.detail).toHaveProperty("count")
      } finally {
        repo.cleanup()
      }
    },
    GIT_HEALTH_TEST_TIMEOUT,
  )

  gitHealthTest("does not flag extra_branches for a repo with few branches", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      await $`git branch feature-one`.cwd(repo.path).quiet()
      await $`git branch feature-two`.cwd(repo.path).quiet()

      const issues = await GitHealth.check(repo.path)
      const extraBranchesIssue = issues.find((i: Issue) => i.dimension === "extra_branches")
      expect(extraBranchesIssue).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — detached HEAD", () => {
  gitHealthTest("detects detached_head issue when HEAD is detached", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path, "root")

      await $`git checkout --detach`.cwd(repo.path).quiet()

      const issues = await GitHealth.check(repo.path)
      const detachedHeadIssue = issues.find((i: Issue) => i.dimension === "detached_head")
      expect(detachedHeadIssue).toBeDefined()
      expectValidIssue(detachedHeadIssue)
      expect(detachedHeadIssue!.level).toBeOneOf(["warn", "critical"])
      expect(detachedHeadIssue!.message).toMatch(/detach/i)
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("does not flag detached_head when on a named branch", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path, "root")

      const issues = await GitHealth.check(repo.path)
      const detachedHeadIssue = issues.find((i: Issue) => i.dimension === "detached_head")
      expect(detachedHeadIssue).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.check — gc needed", () => {
  gitHealthTest("detects gc_needed issue when many loose objects exist", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path, "root")

      // Simulate many loose objects by writing dummy entries under .git/objects
      const objectsDir = join(repo.path, ".git", "objects")
      for (let i = 0; i < 100; i++) {
        const hex = i.toString(16).padStart(2, "0")
        const subDir = join(objectsDir, hex)
        mkdirSync(subDir, { recursive: true })
        writeFileSync(join(subDir, "0000000000000000000000000000000000000000"), "fake object")
      }

      const issues = await GitHealth.check(repo.path)
      const gcIssue = issues.find((i: Issue) => i.dimension === "gc_needed")
      expect(gcIssue).toBeDefined()
      expectValidIssue(gcIssue)
      expect(gcIssue!.level).toBeOneOf(["warn", "critical"])
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("does not flag gc_needed for a clean repo", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path, "root")

      const issues = await GitHealth.check(repo.path)
      const gcIssue = issues.find((i: Issue) => i.dimension === "gc_needed")
      expect(gcIssue).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth caching — check(), lastReport(), invalidate()", () => {
  gitHealthTest("lastReport returns undefined before any check", () => {
    const last = GitHealth.lastReport()
    expect(last).toBeUndefined()
  })

  gitHealthTest("lastReport returns previous check results after check()", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      // Create many untracked files to generate at least one issue
      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      const issues = await GitHealth.check(repo.path)
      const last = GitHealth.lastReport()
      expect(last).toBeDefined()
      expect(last).toEqual(issues)
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("second check() call returns cached results without re-scan", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      // First check — clean repo
      const first = await GitHealth.check(repo.path)

      // Pollute the repo after the first check
      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      // Second check — must return cached (clean) results, ignoring new pollution
      const second = await GitHealth.check(repo.path)
      expect(second).toEqual(first)
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("after invalidate(), next check() re-scans and finds new issues", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      // First check — clean
      const first = await GitHealth.check(repo.path)

      // Pollute the repo
      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      // Invalidate and re-check — must find the new untracked issue
      GitHealth.invalidate()
      const second = await GitHealth.check(repo.path)
      expect(second).not.toEqual(first)

      const untrackedIssue = second.find((i: Issue) => i.dimension === "untracked")
      expect(untrackedIssue).toBeDefined()
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("lastReport returns undefined after invalidate", () => {
    GitHealth.invalidate()
    const last = GitHealth.lastReport()
    expect(last).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.inject()", () => {
  gitHealthTest("returns a string containing <git-health> block with issue details", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      // Detach HEAD to force an issue
      await $`git checkout --detach`.cwd(repo.path).quiet()

      const output = await GitHealth.inject(repo.path)
      expect(output).toBeString()
      expect(output).toMatch(/<git-health>/)
      expect(output).toMatch(/<\/git-health>/)
      expect(output).toMatch(/detach/i)
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("returns undefined when there are no issues (clean repo)", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path, "root")

      const output = await GitHealth.inject(repo.path)
      expect(output).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })

  gitHealthTest("inject() populates lastReport", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      await $`git checkout --detach`.cwd(repo.path).quiet()

      await GitHealth.inject(repo.path)
      const last = GitHealth.lastReport()
      expect(last).toBeArray()
      expect(last!.length).toBeGreaterThan(0)
    } finally {
      repo.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth.injectCached()", () => {
  gitHealthTest("returns undefined immediately before a refresh has populated the cache", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)
      await $`git checkout --detach`.cwd(repo.path).quiet()

      GitHealth.invalidate()
      const output = GitHealth.injectCached(repo.path)
      expect(output).toBeUndefined()
    } finally {
      await GitHealth.refresh(repo.path).catch(() => [])
      GitHealth.invalidate()
      repo.cleanup()
    }
  })

  gitHealthTest("returns the last completed refresh without rescanning synchronously", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      await GitHealth.refresh(repo.path)
      const output = GitHealth.injectCached(repo.path)
      expect(output).toBeString()
      expect(output).toMatch(/untracked/i)
    } finally {
      repo.cleanup()
      GitHealth.invalidate()
    }
  })

  gitHealthTest("refresh de-duplicates concurrent scans for the same directory", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      GitHealth.invalidate()
      const first = GitHealth.refresh(repo.path)
      const second = GitHealth.refresh(repo.path)
      expect(second).toBe(first)
      await first
    } finally {
      repo.cleanup()
      GitHealth.invalidate()
    }
  })

  gitHealthTest("after invalidate, cached injection skips stale diagnostics until refresh completes", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      await GitHealth.refresh(repo.path)
      expect(GitHealth.injectCached(repo.path)).toMatch(/untracked/i)

      GitHealth.invalidate()
      const stale = GitHealth.injectCached(repo.path)
      expect(stale).toBeUndefined()

      await GitHealth.refresh(repo.path)
      expect(GitHealth.injectCached(repo.path)).toMatch(/untracked/i)
    } finally {
      repo.cleanup()
      GitHealth.invalidate()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth cwd parameter", () => {
  gitHealthTest("check(path) uses the specified directory instead of cwd", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    try {
      // repoA: clean
      await gitInit(repoA.path)
      await gitEmptyCommit(repoA.path, "root")

      // repoB: detached HEAD
      await gitInit(repoB.path)
      await gitEmptyCommit(repoB.path, "root")
      await $`git checkout --detach`.cwd(repoB.path).quiet()

      const issuesA = await GitHealth.check(repoA.path)
      const detachedInA = issuesA.find((i: Issue) => i.dimension === "detached_head")
      expect(detachedInA).toBeUndefined()

      const issuesB = await GitHealth.check(repoB.path)
      const detachedInB = issuesB.find((i: Issue) => i.dimension === "detached_head")
      expect(detachedInB).toBeDefined()
    } finally {
      repoA.cleanup()
      repoB.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
describe("GitHealth — multiple issues at once", () => {
  gitHealthTest(
    "returns multiple issues when the repo has several problems",
    async () => {
      const repo = makeRepo()
      try {
        await gitInit(repo.path)
        await gitEmptyCommit(repo.path, "root")

        // Problem 1: Detached HEAD
        await $`git checkout --detach`.cwd(repo.path).quiet()

        // Problem 2: Many untracked files
        for (let i = 1; i <= 50; i++) {
          writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
        }

        // Problem 3: Many stale branches
        // Re-attach briefly to create branches, then detach again
        await $`git checkout -b temp-branch`.cwd(repo.path).quiet()
        for (let i = 1; i <= 25; i++) {
          await $`git branch stale-branch-${i}`.cwd(repo.path).quiet()
        }
        await $`git checkout --detach`.cwd(repo.path).quiet()

        const issues = await GitHealth.check(repo.path)
        expect(issues.length).toBeGreaterThanOrEqual(3)

        const dimensions = issues.map((i: Issue) => i.dimension)
        expect(dimensions).toContain("detached_head")
        expect(dimensions).toContain("untracked")
        expect(dimensions).toContain("extra_branches")
      } finally {
        repo.cleanup()
      }
    },
    GIT_HEALTH_TEST_TIMEOUT,
  )
})
