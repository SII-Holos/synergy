import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { FileIgnore } from "../../src/file/ignore"
import { FileWatcherEvents } from "../../src/file/watcher-events"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

async function waitUntil(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
}

describe("FileWatcherEvents ownership", () => {
  test("keeps .synergy browsable while excluding it from the root watcher", () => {
    expect(FileIgnore.match(".synergy/worktrees/example/src/index.ts")).toBe(false)
    expect(FileWatcherEvents.workspaceSubscriptionIgnores([])).toContain(".synergy")
    expect(FileWatcherEvents.projectRuntimeSubscriptionIgnores()).toContain("worktrees")
  })

  test("publishes only supported project runtime inputs from .synergy", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Promise.all([
          fs.mkdir(path.join(tmp.path, ".synergy", "skill", "demo"), { recursive: true }),
          fs.mkdir(path.join(tmp.path, ".synergy", "agent"), { recursive: true }),
          fs.mkdir(path.join(tmp.path, ".synergy", "command"), { recursive: true }),
        ])
        const files = [
          path.join(tmp.path, ".synergy", "synergy.d", "10-models.jsonc"),
          path.join(tmp.path, ".synergy", "agent", "reviewer.md"),
          path.join(tmp.path, ".synergy", "command", "ship.md"),
          path.join(tmp.path, ".synergy", "skill", "demo", "SKILL.md"),
        ]
        for (const file of files) expect(FileWatcherEvents.isProjectRuntimeInput(file)).toBe(true)

        expect(
          FileWatcherEvents.isProjectRuntimeInput(
            path.join(tmp.path, ".synergy", "worktrees", "task", "src", "index.ts"),
          ),
        ).toBe(false)
        expect(FileWatcherEvents.isProjectRuntimeInput(path.join(tmp.path, ".synergy", "cache", "result.json"))).toBe(
          false,
        )
      },
    })
  })
})

describe("FileWatcherEvents drain", () => {
  test("deduplicates paths and never runs more than one batch concurrently", async () => {
    let active = 0
    let maxActive = 0
    let releaseFirst: (() => void) | undefined
    const batches: FileWatcherEvents.WorkspaceChange[][] = []
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const drain = FileWatcherEvents.createDrain({
      debounceMs: 0,
      maxPending: 100,
      process: async (batch) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        batches.push(batch)
        if (batches.length === 1) await firstBarrier
        active -= 1
      },
      overflow: async () => {},
    })

    drain.enqueue([
      { path: "/repo/src/a.ts", event: "changed" },
      { path: "/repo/src/a.ts", event: "changed" },
    ])
    await waitUntil(() => batches.length === 1)

    drain.enqueue([
      { path: "/repo/src/b.ts", event: "added" },
      { path: "/repo/src/b.ts", event: "changed" },
      { path: "/repo/src/c.ts", event: "changed" },
    ])
    await Bun.sleep(20)
    expect(maxActive).toBe(1)

    releaseFirst?.()
    await drain.idle()

    expect(maxActive).toBe(1)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toEqual([{ path: "/repo/src/a.ts", event: "changed" }])
    expect(batches[1]).toEqual([
      { path: "/repo/src/b.ts", event: "added" },
      { path: "/repo/src/c.ts", event: "changed" },
    ])
    await drain.dispose()
  })

  test("drains events enqueued at the in-flight completion boundary", async () => {
    const batches: FileWatcherEvents.WorkspaceChange[][] = []
    let drain: ReturnType<typeof FileWatcherEvents.createDrain>
    drain = FileWatcherEvents.createDrain({
      debounceMs: 0,
      maxPending: 100,
      process: async (batch) => {
        batches.push(batch)
        if (batches.length !== 1) return
        queueMicrotask(() =>
          queueMicrotask(() => drain.enqueue([{ path: "/repo/src/follow-up.ts", event: "changed" }])),
        )
      },
      overflow: async () => {},
    })

    drain.enqueue([{ path: "/repo/src/initial.ts", event: "changed" }])
    await waitUntil(() => batches.length === 2)
    await drain.idle()

    expect(batches).toEqual([
      [{ path: "/repo/src/initial.ts", event: "changed" }],
      [{ path: "/repo/src/follow-up.ts", event: "changed" }],
    ])
    await drain.dispose()
  })

  test("bounds queue growth and performs one overflow resync", async () => {
    let overflow = 0
    const batches: FileWatcherEvents.WorkspaceChange[][] = []
    const drain = FileWatcherEvents.createDrain({
      debounceMs: 0,
      maxPending: 3,
      process: async (batch) => {
        batches.push(batch)
      },
      overflow: async () => {
        overflow += 1
      },
    })

    drain.enqueue(
      Array.from({ length: 100 }, (_, index) => ({
        path: `/repo/src/${index}.ts`,
        event: "changed" as const,
      })),
    )
    await drain.idle()

    expect(overflow).toBe(1)
    expect(batches).toHaveLength(0)
    expect(drain.pending()).toBe(0)

    drain.enqueue([{ path: "/repo/src/recovered.ts", event: "added" }])
    await drain.idle()
    expect(batches).toEqual([[{ path: "/repo/src/recovered.ts", event: "added" }]])
    await drain.dispose()
  })
})
