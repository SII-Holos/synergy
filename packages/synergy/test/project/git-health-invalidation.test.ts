// ---------------------------------------------------------------------------
// git-health-invalidation.test.ts
//
// Tests for GitHealth.invalidate() integration and the
// git_health_cache_invalidator LoopJob's collect() logic.
//
// Contract:
//   - GitHealth.invalidate() clears _cache and resets _lastDir
//   - collect() returns [] when no bash tool calls found in last assistant
//   - collect() returns one instance when bash tool call completed/errored
//   - collect() returns [] when bash tool is still pending
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"
import { $ } from "bun"
import { LoopJob } from "../../src/session/loop-job"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Dynamic import — GitHealth module
// ---------------------------------------------------------------------------
type GitHealthModule = typeof import("../../src/project/git-health")
let GitHealth: GitHealthModule["GitHealth"]

beforeAll(async () => {
  const mod = await import("../../src/project/git-health")
  GitHealth = mod.GitHealth
})

// ---------------------------------------------------------------------------
// Register the git_health_cache_invalidator job (and other loop signals)
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await import("../../src/session/loop-signals")
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
  const dir = mkdtempSync(join(os.tmpdir(), "synergy-test-git-health-inv-"))
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

// ---------------------------------------------------------------------------
// LoopJob context helpers (modeled after loop-signals.test.ts)
// ---------------------------------------------------------------------------
function makeUser(): any {
  return {
    id: "usr_test",
    role: "user" as const,
    sessionID: "ses_test",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
  }
}

function makeUserWrapper(): any {
  return { info: makeUser(), parts: [] }
}

function makeAssistant(toolParts: any[]): any {
  return {
    info: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      role: "assistant" as const,
      sessionID: "ses_test",
      agent: "synergy",
      mode: "synergy",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test-provider",
      time: { created: Date.now() },
    },
    parts: toolParts,
  }
}

function makeTool(tool: string, input: unknown, status: "pending" | "running" | "completed" | "error"): any {
  const id = `prt_${Math.random().toString(36).slice(2)}`
  const callID = `call_${Math.random().toString(36).slice(2)}`

  if (status === "pending") {
    return {
      id,
      callID,
      messageID: "msg_test",
      sessionID: "ses_test",
      type: "tool",
      tool,
      state: { status, input, raw: JSON.stringify(input) },
    }
  }
  if (status === "running") {
    return {
      id,
      callID,
      messageID: "msg_test",
      sessionID: "ses_test",
      type: "tool",
      tool,
      state: { status, input, title: "Running...", time: { start: Date.now() } },
    }
  }
  if (status === "completed") {
    return {
      id,
      callID,
      messageID: "msg_test",
      sessionID: "ses_test",
      type: "tool",
      tool,
      state: {
        status,
        input,
        output: "ok",
        title: "Done",
        metadata: {},
        time: { start: Date.now() - 100, end: Date.now() },
      },
    }
  }
  // error
  return {
    id,
    callID,
    messageID: "msg_test",
    sessionID: "ses_test",
    type: "tool",
    tool,
    state: {
      status,
      input,
      error: "SomeError: test failure",
      metadata: {},
      time: { start: Date.now() - 100, end: Date.now() },
    },
  }
}

function makeTextPart(text: string): any {
  return {
    id: `prt_${Math.random().toString(36).slice(2)}`,
    messageID: "msg_test",
    sessionID: "ses_test",
    type: "text",
    text,
  }
}

function makeCtx(messages: any[]): any {
  return {
    session: { id: "ses_test" },
    sessionID: "ses_test",
    step: 1,
    messages,
    lastUser: makeUser(),
    lastUserParts: [],
    abort: new AbortController().signal,
    modelLimits: { context: 200_000, output: 8_192 },
  }
}

// ===========================================================================
// GitHealth.invalidate() integration tests
// ===========================================================================

describe("GitHealth.invalidate() — cache clearing via inject()", () => {
  test("invalidate clears lastReport after inject() populated it", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      // Detach HEAD to create an issue
      await $`git checkout --detach`.cwd(repo.path).quiet()

      // inject() populates cache, lastReport is available
      await GitHealth.inject(repo.path)
      const before = GitHealth.lastReport()
      expect(before).toBeArray()
      expect(before!.length).toBeGreaterThan(0)

      // invalidate() clears the cache
      GitHealth.invalidate()
      const after = GitHealth.lastReport()
      expect(after).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })

  test("after invalidate, next inject re-scans instead of returning stale cache", async () => {
    const repo = makeRepo()
    try {
      await gitInit(repo.path)
      await gitEmptyCommit(repo.path)

      // First inject on clean repo — no issues
      const first = await GitHealth.inject(repo.path)
      expect(first).toBeUndefined()

      // Pollute the repo with many untracked files
      for (let i = 1; i <= 50; i++) {
        writeFileSync(join(repo.path, `untracked-${i}.tmp`), `temp ${i}`)
      }

      // Invalidate to clear the stale clean cache
      GitHealth.invalidate()

      // Second inject — must re-scan and find the untracked issue
      const second = await GitHealth.inject(repo.path)
      expect(second).toBeString()
      expect(second).toMatch(/untracked/i)
    } finally {
      repo.cleanup()
    }
  })
})

// ===========================================================================
// git_health_cache_invalidator collect() tests
// ===========================================================================

describe("git_health_cache_invalidator collect()", () => {
  test("returns empty when last message is a user (no assistant)", () => {
    const ctx = makeCtx([makeUserWrapper(), makeUserWrapper()])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeUndefined()
  })

  test("returns empty when assistant has no tool parts", () => {
    const ctx = makeCtx([makeUserWrapper(), makeAssistant([makeTextPart("hello")])])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeUndefined()
  })

  test("returns empty when assistant has only non-bash tool parts", () => {
    const ctx = makeCtx([
      makeUserWrapper(),
      makeAssistant([
        makeTool("Read", { path: "/tmp/foo" }, "completed"),
        makeTool("Grep", { pattern: "foo", path: "/tmp" }, "completed"),
      ]),
    ])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeUndefined()
  })

  test("returns empty when bash tool call is still pending", () => {
    const ctx = makeCtx([makeUserWrapper(), makeAssistant([makeTool("bash", { command: "git status" }, "pending")])])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeUndefined()
  })

  test("returns instance when bash tool call completed", () => {
    const ctx = makeCtx([makeUserWrapper(), makeAssistant([makeTool("bash", { command: "git status" }, "completed")])])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeDefined()
    expect(inv!.type).toBe("git_health_cache_invalidator")
  })

  test("returns instance when bash tool call errored", () => {
    const ctx = makeCtx([makeUserWrapper(), makeAssistant([makeTool("bash", { command: "rm -rf /" }, "error")])])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeDefined()
    expect(inv!.type).toBe("git_health_cache_invalidator")
  })

  test("returns instance when bash tool is running (not pending)", () => {
    const ctx = makeCtx([makeUserWrapper(), makeAssistant([makeTool("bash", { command: "sleep 10" }, "running")])])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeDefined()
    expect(inv!.type).toBe("git_health_cache_invalidator")
  })

  test("returns instance when assistant has mixed tools including bash", () => {
    const ctx = makeCtx([
      makeUserWrapper(),
      makeAssistant([
        makeTool("Read", { path: "/tmp/foo" }, "completed"),
        makeTool("bash", { command: "npm install" }, "completed"),
        makeTool("Grep", { pattern: "test" }, "completed"),
      ]),
    ])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeDefined()
    expect(inv!.type).toBe("git_health_cache_invalidator")
  })

  test("returns empty when assistant parts array is empty", () => {
    const ctx = makeCtx([makeUserWrapper(), makeAssistant([])])
    const instances = LoopJob.collect("post", ctx)
    const inv = instances.find((i: any) => i.type === "git_health_cache_invalidator")
    expect(inv).toBeUndefined()
  })
})
