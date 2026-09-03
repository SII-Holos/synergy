import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { FileIgnore } from "../../src/file/ignore"
import { FileWatcherEvents } from "../../src/file/watcher-events"
import { RuntimeReloadPath } from "../../src/config/reload-path"
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
    expect(FileIgnore.match("node_modules/index.js")).toBe(true)
    expect(FileIgnore.match("nested/node_modules/index.js")).toBe(true)
    expect(FileWatcherEvents.workspaceSubscriptionIgnores([])).toContain("**/.synergy")
    expect(FileWatcherEvents.workspaceSubscriptionIgnores([])).toContain("**/node_modules")
    expect(FileWatcherEvents.workspaceSubscriptionIgnores([])).not.toContain(".synergy")
    expect(FileWatcherEvents.workspaceSubscriptionIgnores(["custom"])).toContain("custom")
    expect(FileWatcherEvents.projectRuntimeSubscriptionIgnores()).toContain("**/worktrees")
  })

  test("native watcher ignores prune nested and dot directories", () => {
    // @parcel/watcher matches non-glob ignore entries only at the top level
    // of the subscribed directory; recursive globs prune nested occurrences
    // (generated worktrees, dependency trees) at any depth.
    const ignores = FileWatcherEvents.workspaceSubscriptionIgnores([])
    expect(ignores).toContain("**/.synergy")
    expect(ignores).toContain("**/dist")
    expect(ignores).not.toContain("dist")
    expect(FileWatcherEvents.projectRuntimeSubscriptionIgnores()).toContain("**/node_modules")
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

describe("FileWatcherEvents path normalization", () => {
  test("uses case-insensitive Windows path keys and preserves the incoming path", () => {
    expect(FileWatcherEvents.normalizePath("C:/Repo/SRC/Index.TS", "win32")).toBe("c:\\repo\\src\\index.ts")
    expect(RuntimeReloadPath.comparisonPath("C:\\Repo\\SRC\\Index.TS", "win32")).toBe("c:\\repo\\src\\index.ts")

    const sameDirectory = FileWatcherEvents.normalize(
      [
        { type: "delete", path: "C:\\Repo\\src\\old.ts" },
        { type: "create", path: "c:/repo/SRC/new.ts" },
      ],
      "win32",
    )
    expect(sameDirectory).toEqual([{ path: "c:/repo/SRC/new.ts", event: "renamed", oldPath: "C:\\Repo\\src\\old.ts" }])
  })

  test("does not infer a rename across Windows directories", () => {
    expect(
      FileWatcherEvents.normalize(
        [
          { type: "delete", path: "C:\\Repo\\old\\file.ts" },
          { type: "create", path: "c:/repo/new/file.ts" },
        ],
        "win32",
      ),
    ).toEqual([
      { path: "c:/repo/new/file.ts", event: "added" },
      { path: "C:\\Repo\\old\\file.ts", event: "deleted" },
    ])
  })

  test("does not classify replacing the same path as a rename", () => {
    expect(
      FileWatcherEvents.normalize(
        [
          { type: "delete", path: "C:\\Repo\\src\\file.ts" },
          { type: "create", path: "c:/repo/SRC/FILE.ts" },
        ],
        "win32",
      ),
    ).toEqual([{ path: "c:/repo/SRC/FILE.ts", event: "changed" }])
  })

  test("keeps POSIX comparison case-sensitive", () => {
    expect(FileWatcherEvents.normalizePath("/Repo/SRC/Index.TS", "posix")).toBe("/Repo/SRC/Index.TS")
    expect(RuntimeReloadPath.comparisonPath("/Repo/SRC/Index.TS", "posix")).toBe("/Repo/SRC/Index.TS")

    expect(
      FileWatcherEvents.normalize(
        [
          { type: "delete", path: "/Repo/src/old.ts" },
          { type: "create", path: "/Repo/src/new.ts" },
        ],
        "posix",
      ),
    ).toEqual([{ path: "/Repo/src/new.ts", event: "renamed", oldPath: "/Repo/src/old.ts" }])
    expect(
      FileWatcherEvents.normalize(
        [
          { type: "delete", path: "/Repo/src/old.ts" },
          { type: "create", path: "/repo/src/new.ts" },
        ],
        "posix",
      ),
    ).toEqual([
      { path: "/repo/src/new.ts", event: "added" },
      { path: "/Repo/src/old.ts", event: "deleted" },
    ])
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

  test("deduplicates Windows paths that differ only by slash or case", async () => {
    const batches: FileWatcherEvents.WorkspaceChange[][] = []
    const drain = FileWatcherEvents.createDrain({
      debounceMs: 0,
      maxPending: 10,
      platform: "win32",
      process: async (batch) => {
        batches.push(batch)
      },
      overflow: async () => {},
    })

    drain.enqueue([
      { path: "C:\\Repo\\SRC\\index.ts", event: "changed" },
      { path: "c:/repo/src/INDEX.ts", event: "changed" },
    ])
    await drain.idle()

    expect(batches).toEqual([[{ path: "c:/repo/src/INDEX.ts", event: "changed" }]])
    await drain.dispose()
  })

  test("keeps an atomic replacement as changed instead of dropping it", async () => {
    const batches: FileWatcherEvents.WorkspaceChange[][] = []
    const drain = FileWatcherEvents.createDrain({
      debounceMs: 0,
      maxPending: 10,
      platform: "win32",
      process: async (batch) => {
        batches.push(batch)
      },
      overflow: async () => {},
    })

    drain.enqueue(
      FileWatcherEvents.normalize(
        [
          { type: "delete", path: "C:\\Repo\\src\\file.ts" },
          { type: "create", path: "c:/repo/SRC/FILE.ts" },
        ],
        "win32",
      ),
    )
    await drain.idle()

    expect(batches).toEqual([[{ path: "c:/repo/SRC/FILE.ts", event: "changed" }]])
    await drain.dispose()
  })

  test("preserves the old path when a rename is followed by a changed event", async () => {
    const batches: FileWatcherEvents.WorkspaceChange[][] = []
    const drain = FileWatcherEvents.createDrain({
      debounceMs: 10,
      maxPending: 10,
      process: async (batch) => {
        batches.push(batch)
      },
      overflow: async () => {},
    })

    drain.enqueue([{ path: "/repo/src/new.ts", event: "renamed", oldPath: "/repo/src/old.ts" }])
    drain.enqueue([{ path: "/repo/src/new.ts", event: "changed" }])
    await drain.idle()

    expect(batches).toEqual([[{ path: "/repo/src/new.ts", event: "renamed", oldPath: "/repo/src/old.ts" }]])
    await drain.dispose()
  })

  test("preserves the rename source through later destination changes", async () => {
    for (const event of ["changed", "added"] as const) {
      const batches: FileWatcherEvents.WorkspaceChange[][] = []
      const drain = FileWatcherEvents.createDrain({
        debounceMs: 10,
        maxPending: 10,
        process: async (batch) => {
          batches.push(batch)
        },
        overflow: async () => {},
      })

      drain.enqueue([{ path: "/repo/src/new.ts", event: "renamed", oldPath: "/repo/src/old.ts" }])
      drain.enqueue([{ path: "/repo/src/new.ts", event }])
      await drain.idle()

      expect(batches).toEqual([[{ path: "/repo/src/new.ts", event: "renamed", oldPath: "/repo/src/old.ts" }]])
      await drain.dispose()
    }
  })

  test("resyncs when a renamed destination is deleted before the batch is published", async () => {
    const batches: FileWatcherEvents.WorkspaceChange[][] = []
    let resyncs = 0
    const drain = FileWatcherEvents.createDrain({
      debounceMs: 10,
      maxPending: 10,
      process: async (batch) => {
        batches.push(batch)
      },
      overflow: async () => {
        resyncs += 1
      },
    })

    drain.enqueue([{ path: "/repo/src/new.ts", event: "renamed", oldPath: "/repo/src/old.ts" }])
    drain.enqueue([{ path: "/repo/src/new.ts", event: "deleted" }])
    await drain.idle()

    expect(batches).toEqual([])
    expect(resyncs).toBe(1)
    await drain.dispose()
  })
})

describe("FileWatcherEvents subscription recovery", () => {
  test("reports failure, resubscribes, and disconnects the failed subscription", async () => {
    let attempts = 0
    let disconnects = 0
    const errors: unknown[] = []
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      retryMs: 0,
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("backend unavailable")
        return { id: attempts }
      },
      disconnect: async () => {
        disconnects += 1
      },
      onError: (error) => {
        errors.push(error)
      },
    })

    await recovery.start()
    await waitUntil(() => recovery.active() && attempts === 2)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("backend unavailable")

    await recovery.fail(new Error("watch stream closed"))
    await waitUntil(() => recovery.active() && attempts === 3)
    expect(disconnects).toBe(1)
    expect(errors).toHaveLength(2)

    await recovery.dispose()
    expect(disconnects).toBe(2)
  })

  test("waits for unsubscribe before reconnecting", async () => {
    let attempts = 0
    const order: string[] = []
    let releaseUnsubscribe: (() => void) | undefined
    const unsubscribeStarted = new Promise<void>((resolve) => {
      releaseUnsubscribe = resolve
    })
    let unsubscribeCalled = false
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      retryMs: 0,
      connect: async () => ({ id: ++attempts }),
      disconnect: async () => {
        order.push("unsubscribe:start")
        unsubscribeCalled = true
        await unsubscribeStarted
        order.push("unsubscribe:done")
      },
      onError: () => {
        order.push("resync")
      },
    })

    await recovery.start()
    const failing = recovery.fail(new Error("watch stream closed"))
    await waitUntil(() => unsubscribeCalled)
    await Bun.sleep(10)
    expect(attempts).toBe(1)

    releaseUnsubscribe?.()
    await failing
    await waitUntil(() => attempts === 2 && recovery.active())
    expect(order).toEqual(["unsubscribe:start", "unsubscribe:done", "resync"])
    await recovery.dispose()
  })

  test("waits for unsubscribe before dispose completes", async () => {
    let releaseUnsubscribe: (() => void) | undefined
    const unsubscribeStarted = new Promise<void>((resolve) => {
      releaseUnsubscribe = resolve
    })
    let unsubscribeCalled = false
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      connect: async () => ({ id: 1 }),
      disconnect: async () => {
        unsubscribeCalled = true
        await unsubscribeStarted
      },
      onError: () => {},
    })

    await recovery.start()
    let disposed = false
    const disposing = recovery.dispose().then(() => {
      disposed = true
    })
    await waitUntil(() => unsubscribeCalled)
    await Bun.sleep(10)
    expect(disposed).toBe(false)

    releaseUnsubscribe?.()
    await disposing
    expect(disposed).toBe(true)
  })

  test("waits for asynchronous failure handling before dispose completes", async () => {
    let releaseResync: (() => void) | undefined
    const resyncStarted = new Promise<void>((resolve) => {
      releaseResync = resolve
    })
    let resyncCalled = false
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      connect: async () => ({ id: 1 }),
      disconnect: async () => {},
      onError: async () => {
        resyncCalled = true
        await resyncStarted
      },
    })

    await recovery.start()
    const failing = recovery.fail(new Error("watch stream closed"))
    await waitUntil(() => resyncCalled)

    let disposed = false
    const disposing = recovery.dispose().then(() => {
      disposed = true
    })
    await Bun.sleep(10)
    expect(disposed).toBe(false)

    releaseResync?.()
    await Promise.all([failing, disposing])
    expect(disposed).toBe(true)
  })

  test("allows onError to dispose the recovery without waiting for itself", async () => {
    let recovery!: ReturnType<typeof FileWatcherEvents.createSubscriptionRecovery<{ id: number }>>
    recovery = FileWatcherEvents.createSubscriptionRecovery({
      connect: async () => ({ id: 1 }),
      disconnect: async () => {},
      onError: async () => {
        await recovery.dispose()
      },
    })

    await recovery.start()
    await Promise.race([
      recovery.fail(new Error("watch stream closed")),
      Bun.sleep(100).then(() => {
        throw new Error("timed out waiting for reentrant dispose")
      }),
    ])
    expect(recovery.active()).toBe(false)
    await recovery.dispose()
  })

  test("keeps compensation callbacks scoped to each failed subscription", async () => {
    const compensations: string[] = []
    const createFailedRecovery = (label: string) =>
      FileWatcherEvents.createSubscriptionRecovery({
        retryMs: 60_000,
        connect: async () => {
          throw new Error(`${label} watcher failed`)
        },
        disconnect: async () => {},
        onError: () => {
          compensations.push(label)
        },
      })
    const globalRecovery = createFailedRecovery("global config")
    const projectRecovery = createFailedRecovery("project config")

    await Promise.all([globalRecovery.start(), projectRecovery.start()])
    expect(compensations).toEqual(["global config", "project config"])

    await Promise.all([globalRecovery.dispose(), projectRecovery.dispose()])
  })

  test("turns a watcher failure into the same serialized resync path as overflow", async () => {
    let resyncs = 0
    const drain = FileWatcherEvents.createDrain({
      debounceMs: 0,
      maxPending: 4_096,
      process: async () => {},
      overflow: async () => {
        resyncs += 1
      },
    })
    drain.resync()
    await drain.idle()
    expect(resyncs).toBe(1)
    await drain.dispose()
  })

  test("ignores a failure from an obsolete connection generation", async () => {
    const contexts: Array<{ generation: number; fail: (error: unknown) => Promise<void> }> = []
    let attempts = 0
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      retryMs: 0,
      connect: async (context) => {
        attempts += 1
        contexts.push(context)
        return { id: attempts }
      },
      disconnect: async () => {},
      onError: () => {},
    })

    await recovery.start()
    await contexts[0]!.fail(new Error("first connection failed"))
    await waitUntil(() => recovery.active() && attempts === 2)

    await contexts[0]!.fail(new Error("late failure from first connection"))
    await Bun.sleep(10)
    expect(recovery.active()).toBe(true)
    expect(attempts).toBe(2)

    await recovery.dispose()
  })

  test("dispose does not wait for a connection that never settles", async () => {
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      connect: () => new Promise(() => {}),
      disconnect: async () => {},
      onError: () => {},
    })

    const starting = recovery.start()
    await Bun.sleep(0)
    await recovery.dispose()
    expect(recovery.active()).toBe(false)
    await Promise.race([starting, Bun.sleep(20)])
  })
})

describe("FileWatcherEvents error classification", () => {
  test("classifies inotify capacity errors", () => {
    expect(
      FileWatcherEvents.isInotifyCapacityError(new Error("inotify_add_watch on '/x' failed: No space left on device")),
    ).toBe(true)
    expect(FileWatcherEvents.isInotifyCapacityError(new Error("inotify_init1 failed: ENOSPC"))).toBe(true)
    expect(FileWatcherEvents.isInotifyCapacityError(new Error("watch stream closed"))).toBe(false)
    expect(FileWatcherEvents.isTerminalWatcherError(new Error("... No space left on device"), "linux")).toBe(true)
    expect(FileWatcherEvents.isTerminalWatcherError(new Error("... No space left on device"), "darwin")).toBe(false)
    expect(FileWatcherEvents.isTerminalWatcherError(new Error("backend unavailable"), "linux")).toBe(false)
  })
})

describe("FileWatcherEvents subscription timeout policy", () => {
  test("Linux waits for the native attempt to settle instead of timing it out", () => {
    expect(FileWatcherEvents.nativeSubscribeTimeoutMs("linux")).toBeUndefined()
    expect(FileWatcherEvents.nativeSubscribeTimeoutMs("darwin")).toBe(10_000)
    expect(FileWatcherEvents.nativeSubscribeTimeoutMs("win32")).toBe(10_000)
  })

  test("a terminal failure stops the recovery instead of retrying", async () => {
    let attempts = 0
    const errors: unknown[] = []
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      retryMs: 0,
      connect: async () => {
        attempts += 1
        throw new Error(`inotify_add_watch on '/x' failed: No space left on device`)
      },
      disconnect: async () => {},
      onError: (error) => {
        errors.push(error)
      },
      terminal: (error) => FileWatcherEvents.isTerminalWatcherError(error, "linux"),
    })

    await recovery.start()
    await Bun.sleep(30)
    expect(attempts).toBe(1)
    expect(errors).toHaveLength(1)
    expect(recovery.active()).toBe(false)

    await recovery.dispose()
    expect(attempts).toBe(1)
  })

  test("a transient failure still retries when terminal is provided", async () => {
    let attempts = 0
    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      retryMs: 0,
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("backend unavailable")
        return { id: attempts }
      },
      disconnect: async () => {},
      onError: () => {},
      terminal: (error) => FileWatcherEvents.isTerminalWatcherError(error, "linux"),
    })

    await recovery.start()
    await waitUntil(() => recovery.active() && attempts === 2)
    expect(attempts).toBe(2)
    await recovery.dispose()
  })
})
