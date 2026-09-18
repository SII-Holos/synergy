import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createDesktopActivityWatcher,
  createDesktopPowerGuard,
  defaultDesktopPowerState,
  desktopPowerFilePath,
  loadDesktopPower,
  parseDesktopActivity,
  parseDesktopPowerUpdate,
  saveDesktopPower,
  type PowerSaveBlockerLike,
} from "../src/power-save.js"

const temps: string[] = []

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "synergy-desktop-power-"))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(2)
  }
  throw new Error("timed out waiting for condition")
}

describe("desktop power state", () => {
  test("defaults to keep-awake disabled", () => {
    expect(defaultDesktopPowerState()).toEqual({ version: 1, keepAwakeWhileRunning: false })
  })

  test("round-trips a saved state", async () => {
    const dir = await tempDir()
    await saveDesktopPower(dir, { version: 1, keepAwakeWhileRunning: true })
    expect(await loadDesktopPower(dir)).toEqual({ version: 1, keepAwakeWhileRunning: true })
    expect(desktopPowerFilePath(dir)).toBe(path.join(dir, "desktop-power.json"))
  })

  test("falls back to the default for every unreadable or invalid record", async () => {
    const expected = { version: 1, keepAwakeWhileRunning: false }

    const missing = await tempDir()
    expect(await loadDesktopPower(missing)).toEqual(expected)

    const unreadable = await tempDir()
    await mkdir(desktopPowerFilePath(unreadable))
    expect(await loadDesktopPower(unreadable)).toEqual(expected)

    const cases: Array<[string, string]> = [
      ["bad json", "{not json"],
      ["wrong version", JSON.stringify({ version: 2, keepAwakeWhileRunning: true })],
      ["wrong shape", JSON.stringify({ version: 1, keepAwakeWhileRunning: "yes" })],
      ["extra key", JSON.stringify({ version: 1, keepAwakeWhileRunning: true, extra: true })],
      ["missing key", JSON.stringify({ version: 1 })],
      ["not an object", JSON.stringify([1, 2, 3])],
    ]
    for (const [label, content] of cases) {
      const dir = await tempDir()
      await writeFile(desktopPowerFilePath(dir), content)
      expect(await loadDesktopPower(dir), label).toEqual(expected)
    }
  })

  test("accepts only strict keep-awake updates", () => {
    expect(parseDesktopPowerUpdate({ keepAwakeWhileRunning: true })).toEqual({ keepAwakeWhileRunning: true })
    expect(parseDesktopPowerUpdate({ keepAwakeWhileRunning: false })).toEqual({ keepAwakeWhileRunning: false })
    expect(() => parseDesktopPowerUpdate({ keepAwakeWhileRunning: true, extra: true })).toThrow()
    expect(() => parseDesktopPowerUpdate({ keepAwakeWhileRunning: "yes" })).toThrow()
    expect(() => parseDesktopPowerUpdate({})).toThrow()
    expect(() => parseDesktopPowerUpdate(null)).toThrow()
  })

  test("accepts only strict activity payloads", () => {
    expect(parseDesktopActivity({ active: true, sessions: 2, backgroundJobs: 1 })).toEqual({
      active: true,
      sessions: 2,
      backgroundJobs: 1,
    })
    expect(() => parseDesktopActivity({ active: true, sessions: -1, backgroundJobs: 0 })).toThrow()
    expect(() => parseDesktopActivity({ active: true, sessions: 1.5, backgroundJobs: 0 })).toThrow()
    expect(() => parseDesktopActivity({ active: true, sessions: 1, backgroundJobs: 0, extra: true })).toThrow()
    expect(() => parseDesktopActivity({ active: "yes", sessions: 1, backgroundJobs: 0 })).toThrow()
    expect(() => parseDesktopActivity({ active: true, sessions: 1 })).toThrow()
  })
})

function blockerFixture(options: { externallyStopped?: boolean } = {}) {
  const starts: Array<{ id: number; type: string }> = []
  const stops: number[] = []
  const stopped = new Set<number>()
  let next = 1
  const blocker: PowerSaveBlockerLike = {
    start(type) {
      const id = next++
      starts.push({ id, type })
      if (options.externallyStopped && starts.length === 1) stopped.add(id)
      return id
    },
    stop(id) {
      stops.push(id)
      stopped.add(id)
    },
    isStarted(id) {
      return !stopped.has(id)
    },
  }
  return { blocker, starts, stops, stopped }
}

describe("desktop power guard", () => {
  test("holds a single prevent-app-suspension assertion and never stacks duplicates", () => {
    const { blocker, starts, stops } = blockerFixture()
    const guard = createDesktopPowerGuard(blocker)

    expect(guard.active()).toBe(false)
    guard.apply(true)
    guard.apply(true)
    guard.apply(true)
    expect(starts).toEqual([{ id: 1, type: "prevent-app-suspension" }])
    expect(guard.active()).toBe(true)

    guard.apply(false)
    expect(stops).toEqual([1])
    expect(guard.active()).toBe(false)

    guard.apply(false)
    guard.release()
    expect(stops).toEqual([1])
  })

  test("restarts the assertion after the system releases it unexpectedly", () => {
    const { blocker, starts, stopped } = blockerFixture()
    const guard = createDesktopPowerGuard(blocker)

    guard.apply(true)
    expect(guard.active()).toBe(true)

    stopped.add(1)
    expect(guard.active()).toBe(false)

    guard.apply(true)
    expect(starts).toEqual([
      { id: 1, type: "prevent-app-suspension" },
      { id: 2, type: "prevent-app-suspension" },
    ])
    expect(guard.active()).toBe(true)
  })

  test("release forces the assertion down regardless of prior state", () => {
    const { blocker, stops } = blockerFixture()
    const guard = createDesktopPowerGuard(blocker)
    guard.apply(true)
    guard.release()
    expect(stops).toEqual([1])
    expect(guard.active()).toBe(false)
  })
})

interface WatcherHarness {
  scheduled: string[]
  calls: number
  desired: boolean[]
  errors: unknown[]
  watcher: ReturnType<typeof createDesktopActivityWatcher>
}

function watcherFixture(input: {
  resolve: () => Promise<unknown> | unknown
  baseUrl?: () => string | null
  overrides?: Partial<Parameters<typeof createDesktopActivityWatcher>[0]>
}): WatcherHarness {
  const scheduled: string[] = []
  const desired: boolean[] = []
  const errors: unknown[] = []
  let calls = 0
  const watcher = createDesktopActivityWatcher({
    intervalMs: 5,
    failureGraceMs: 30,
    releaseDebounceMs: 20,
    resolveBaseUrl: input.baseUrl ?? (() => "http://127.0.0.1:4096"),
    fetchActivity: async (url) => {
      calls++
      scheduled.push(url)
      return await input.resolve()
    },
    onDesiredChange: (value) => desired.push(value),
    onError: (error) => errors.push(error),
    ...input.overrides,
  })
  return {
    scheduled,
    get calls() {
      return calls
    },
    desired,
    errors,
    watcher,
  }
}

describe("desktop activity watcher", () => {
  test("does not poll before start", async () => {
    const fixture = watcherFixture({ resolve: () => ({ active: true, sessions: 1, backgroundJobs: 0 }) })
    await Bun.sleep(30)
    expect(fixture.calls).toBe(0)
    expect(fixture.desired).toEqual([])
    fixture.watcher.stop()
  })

  test("requests the global activity endpoint and raises intent immediately", async () => {
    const fixture = watcherFixture({ resolve: () => ({ active: true, sessions: 1, backgroundJobs: 0 }) })
    fixture.watcher.start()
    await waitFor(() => fixture.desired.length > 0)
    expect(fixture.scheduled[0]).toBe("http://127.0.0.1:4096/global/activity")
    expect(fixture.desired).toEqual([true])
    await waitFor(() => fixture.calls >= 3)
    expect(fixture.desired).toEqual([true])
    fixture.watcher.stop()
  })

  test("waits out the release debounce before dropping intent", async () => {
    let active = true
    const fixture = watcherFixture({ resolve: () => ({ active, sessions: active ? 1 : 0, backgroundJobs: 0 }) })
    fixture.watcher.start()
    await waitFor(() => fixture.desired.length === 1)

    active = false
    await waitFor(() => fixture.calls >= 3)
    expect(fixture.desired).toEqual([true])

    await waitFor(() => fixture.desired.length === 2)
    expect(fixture.desired).toEqual([true, false])
    fixture.watcher.stop()
  })

  test("cancels a pending release when work resumes inside the debounce", async () => {
    let active = true
    const fixture = watcherFixture({ resolve: () => ({ active, sessions: active ? 1 : 0, backgroundJobs: 0 }) })
    fixture.watcher.start()
    await waitFor(() => fixture.desired.length === 1)

    active = false
    await Bun.sleep(5)
    active = true
    await waitFor(() => fixture.calls >= 4)
    expect(fixture.desired).toEqual([true])
    fixture.watcher.stop()
  })

  test("keeps intent through transient failures and drops it once the grace expires", async () => {
    let failing = false
    const fixture = watcherFixture({
      resolve: () => {
        if (failing) throw new Error("activity unreachable")
        return { active: true, sessions: 1, backgroundJobs: 0 }
      },
    })
    fixture.watcher.start()
    await waitFor(() => fixture.desired.length === 1)

    failing = true
    await Bun.sleep(10)
    expect(fixture.desired).toEqual([true])

    await waitFor(() => fixture.desired.length === 2, 3000)
    expect(fixture.desired).toEqual([true, false])
    expect(fixture.errors.length).toBeGreaterThan(0)
    fixture.watcher.stop()
  })

  test("recovers after the grace expires and work resumes", async () => {
    let failing = false
    const fixture = watcherFixture({
      resolve: () => {
        if (failing) throw new Error("activity unreachable")
        return { active: true, sessions: 1, backgroundJobs: 0 }
      },
    })
    fixture.watcher.start()
    await waitFor(() => fixture.desired.length === 1)

    failing = true
    await waitFor(() => fixture.desired.length === 2, 3000)
    expect(fixture.desired).toEqual([true, false])

    failing = false
    await waitFor(() => fixture.desired[fixture.desired.length - 1] === true)
    expect(fixture.desired).toEqual([true, false, true])
    fixture.watcher.stop()
  })

  test("treats a missing server url as no work without issuing a request", async () => {
    const fixture = watcherFixture({
      resolve: () => ({ active: true, sessions: 1, backgroundJobs: 0 }),
      baseUrl: () => null,
    })
    fixture.watcher.start()
    await Bun.sleep(30)
    expect(fixture.calls).toBe(0)
    expect(fixture.desired).toEqual([])
    fixture.watcher.stop()
  })

  test("stop aborts in-flight work, clears timers, and releases intent", async () => {
    let resolvePoll: ((value: unknown) => void) | undefined
    const fixture = watcherFixture({
      resolve: () =>
        new Promise((resolve) => {
          resolvePoll = resolve
        }),
    })
    fixture.watcher.start()
    await waitFor(() => fixture.calls === 1)

    fixture.watcher.stop()
    expect(fixture.desired).toEqual([])

    resolvePoll?.({ active: true, sessions: 1, backgroundJobs: 0 })
    const calls = fixture.calls
    await Bun.sleep(30)
    expect(fixture.calls).toBe(calls)
    expect(fixture.desired).toEqual([])
  })

  test("stop releases held intent so the assertion can never leak", async () => {
    const fixture = watcherFixture({ resolve: () => ({ active: true, sessions: 1, backgroundJobs: 0 }) })
    fixture.watcher.start()
    await waitFor(() => fixture.desired.length === 1)
    fixture.watcher.stop()
    expect(fixture.desired).toEqual([true, false])
  })

  test("recheck coalesces while a poll is in flight instead of stacking requests", async () => {
    const pending: Array<(value: unknown) => void> = []
    const fixture = watcherFixture({
      resolve: () =>
        new Promise((resolve) => {
          pending.push(resolve)
        }),
    })
    fixture.watcher.start()
    await waitFor(() => fixture.calls === 1)
    for (let index = 0; index < 20; index++) fixture.watcher.recheck()
    expect(fixture.calls).toBe(1)

    pending.shift()?.({ active: true, sessions: 1, backgroundJobs: 0 })
    await waitFor(() => fixture.calls === 2)
    expect(fixture.calls).toBe(2)

    pending.shift()?.({ active: true, sessions: 1, backgroundJobs: 0 })
    await waitFor(() => fixture.calls === 3)
    pending.shift()?.({ active: true, sessions: 1, backgroundJobs: 0 })
    fixture.watcher.stop()
  })

  test("recheck is inert before start", async () => {
    const fixture = watcherFixture({ resolve: () => ({ active: true, sessions: 1, backgroundJobs: 0 }) })
    fixture.watcher.recheck()
    await Bun.sleep(20)
    expect(fixture.calls).toBe(0)
    fixture.watcher.stop()
  })
})
