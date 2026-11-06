import { describe, expect, test } from "bun:test"
import { VcsBranchWatcher } from "../../src/project/vcs-branch-watcher"

describe("VcsBranchWatcher", () => {
  test("ignores ordinary workspace events and coalesces HEAD refreshes", async () => {
    let branch = "main"
    let resolves = 0
    const updates: string[] = []
    const watcher = VcsBranchWatcher.create({
      debounceMs: 0,
      resolve: async () => {
        resolves += 1
        return branch
      },
      onChange: async (next) => {
        if (next) updates.push(next)
      },
    })

    expect(await watcher.start()).toBe("main")
    watcher.notify("src/index.ts")
    watcher.notify("README.md")
    await watcher.idle()
    expect(resolves).toBe(1)

    branch = "feature"
    for (let index = 0; index < 1_000; index += 1) watcher.notify(".git/HEAD")
    await watcher.idle()

    expect(resolves).toBe(2)
    expect(updates).toEqual(["feature"])
    await watcher.dispose()
  })

  test("refreshes again when HEAD changes at the in-flight completion boundary", async () => {
    let branch = "main"
    let resolves = 0
    let watcher: VcsBranchWatcher.Watcher
    watcher = VcsBranchWatcher.create({
      debounceMs: 0,
      resolve: async () => {
        resolves += 1
        if (resolves === 2) queueMicrotask(() => queueMicrotask(() => watcher.notify(".git/HEAD")))
        return branch
      },
      onChange: async () => {},
    })

    await watcher.start()
    watcher.notify(".git/HEAD")
    await Bun.sleep(20)

    expect(resolves).toBe(3)
    await watcher.idle()
    await watcher.dispose()
  })

  test("stops pending refreshes on disposal", async () => {
    let resolves = 0
    const watcher = VcsBranchWatcher.create({
      debounceMs: 1_000,
      resolve: async () => {
        resolves += 1
        return "main"
      },
      onChange: async () => {},
    })

    await watcher.start()
    watcher.notify(".git/HEAD")
    await watcher.dispose()
    await watcher.idle()

    expect(resolves).toBe(1)
  })
})
