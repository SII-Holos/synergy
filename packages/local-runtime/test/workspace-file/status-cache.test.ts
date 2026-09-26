import { describe, expect, test } from "bun:test"
import { WorkspaceFileStatusCache } from "../../src/workspace-file/status-cache"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("WorkspaceFileStatusCache", () => {
  test("shares one build across concurrent forced callers", async () => {
    const started = deferred()
    const release = deferred()
    let builds = 0
    const cache = WorkspaceFileStatusCache.create({
      ttlMs: 5_000,
      build: async () => {
        builds += 1
        started.resolve()
        await release.promise
        return `build-${builds}`
      },
    })

    const callers = [cache.get({ force: true }), cache.get({ force: true }), cache.get({ force: true })]
    await started.promise
    expect(builds).toBe(1)

    release.resolve()
    expect(await Promise.all(callers)).toEqual(["build-1", "build-1", "build-1"])
    expect(builds).toBe(1)
  })

  test("performs at most one follow-up build for invalidation during a build", async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    let builds = 0
    const cache = WorkspaceFileStatusCache.create({
      ttlMs: 5_000,
      build: async () => {
        builds += 1
        if (builds === 1) {
          firstStarted.resolve()
          await releaseFirst.promise
        }
        return `build-${builds}`
      },
    })

    const result = cache.get({ force: true })
    await firstStarted.promise
    cache.invalidate()
    cache.invalidate()
    releaseFirst.resolve()

    expect(await result).toBe("build-2")
    expect(builds).toBe(2)
    expect(await cache.get()).toBe("build-2")
    expect(builds).toBe(2)
  })

  test("leaves later invalidations stale instead of starting parallel builders", async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const secondStarted = deferred()
    const releaseSecond = deferred()
    let builds = 0
    const cache = WorkspaceFileStatusCache.create({
      ttlMs: 5_000,
      build: async () => {
        builds += 1
        if (builds === 1) {
          firstStarted.resolve()
          await releaseFirst.promise
        }
        if (builds === 2) {
          secondStarted.resolve()
          await releaseSecond.promise
        }
        return `build-${builds}`
      },
    })

    const first = cache.get({ force: true })
    await firstStarted.promise
    cache.invalidate()
    releaseFirst.resolve()
    await secondStarted.promise
    cache.invalidate()
    cache.invalidate()
    releaseSecond.resolve()

    expect(await first).toBe("build-2")
    expect(builds).toBe(2)
    expect(await cache.get()).toBe("build-3")
    expect(builds).toBe(3)
  })
})
