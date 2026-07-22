import { beforeEach, describe, expect, test } from "bun:test"
import { SessionMemoryPressure } from "../../src/session/memory-pressure"

const env = {
  SYNERGY_SESSION_GC_MIN_INTERVAL_MS: "10000",
  SYNERGY_SESSION_GC_HEAP_USED_SOFT_BYTES: "500",
  SYNERGY_SESSION_GC_EXTERNAL_SOFT_BYTES: "500",
  SYNERGY_SESSION_GC_ARRAY_BUFFERS_SOFT_BYTES: "500",
  SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES: "1000",
  SYNERGY_SESSION_GC_HEAP_USED_CRITICAL_BYTES: "1000",
  SYNERGY_SESSION_GC_EXTERNAL_CRITICAL_BYTES: "1000",
  SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES: "1000",
  SYNERGY_SESSION_GC_CGROUP_CRITICAL_BYTES: "1000",
}

const healthySnapshot: SessionMemoryPressure.Snapshot = {
  rssBytes: 100,
  heapUsedBytes: 50,
  heapTotalBytes: 80,
  externalBytes: 20,
  arrayBuffersBytes: 10,
}

describe("SessionMemoryPressure", () => {
  beforeEach(() => {
    SessionMemoryPressure.resetForTest()
  })

  test("skips normal GC while the minimum interval has not elapsed", async () => {
    SessionMemoryPressure.resetForTest(1_000)
    let collected = false

    const result = await SessionMemoryPressure.maybeCollect({
      phase: "test",
      now: () => 1_500,
      snapshot: () => healthySnapshot,
      collect: () => {
        collected = true
      },
      env,
    })

    expect(result.decision.action).toBe("skip")
    expect(collected).toBe(false)
  })

  test("runs asynchronous GC when the minimum interval has elapsed", async () => {
    SessionMemoryPressure.resetForTest(1_000)
    const calls: boolean[] = []

    const result = await SessionMemoryPressure.maybeCollect({
      phase: "test",
      now: () => 12_000,
      snapshot: () => healthySnapshot,
      collect: (synchronous) => {
        calls.push(synchronous)
      },
      env,
    })

    expect(result.decision.action).toBe("normal")
    expect(calls).toEqual([false])
  })

  test("coalesces released-history signals into one asynchronous collection", async () => {
    const calls: boolean[] = []
    const signal = {
      phase: "test.history.complete",
      now: () => 12_000,
      snapshot: () => healthySnapshot,
      collect: (synchronous: boolean) => {
        calls.push(synchronous)
      },
      env,
    }

    SessionMemoryPressure.signalRelease(signal)
    SessionMemoryPressure.signalRelease(signal)

    expect(calls).toEqual([])
    const result = await SessionMemoryPressure.flushReleaseSignalsForTest()
    expect(result?.releaseCount).toBe(2)
    expect(result?.decision.action).toBe("normal")
    expect(calls).toEqual([false])
  })

  test("keeps released-history collection behind the minimum interval", async () => {
    SessionMemoryPressure.resetForTest(1_000)
    const calls: boolean[] = []

    SessionMemoryPressure.signalRelease({
      phase: "test.history.complete",
      now: () => 1_500,
      snapshot: () => healthySnapshot,
      collect: (synchronous) => {
        calls.push(synchronous)
      },
      env,
    })

    const result = await SessionMemoryPressure.flushReleaseSignalsForTest()
    expect(result?.decision.action).toBe("skip")
    expect(calls).toEqual([])
  })

  test("keeps critical pressure behind the process-wide minimum interval", async () => {
    SessionMemoryPressure.resetForTest(1_000)
    const calls: boolean[] = []

    const result = await SessionMemoryPressure.maybeCollect({
      phase: "test",
      now: () => 1_500,
      snapshot: () => ({
        ...healthySnapshot,
        rssBytes: 2_000,
      }),
      collect: (synchronous) => {
        calls.push(synchronous)
      },
      env,
    })

    expect(result.decision).toMatchObject({ action: "skip", critical: true })
    expect(calls).toEqual([])
  })

  test("requests asynchronous GC when critical pressure is eligible", async () => {
    const calls: boolean[] = []

    const result = await SessionMemoryPressure.maybeCollect({
      phase: "test",
      now: () => 1_500,
      snapshot: () => ({
        ...healthySnapshot,
        rssBytes: 2_000,
      }),
      collect: (synchronous) => {
        calls.push(synchronous)
      },
      env,
    })

    expect(result.decision.action).toBe("critical")
    expect(calls).toEqual([false])
  })

  test("coalesces concurrent collection requests across sessions", async () => {
    const calls: boolean[] = []
    const input = {
      phase: "test",
      now: () => 12_000,
      snapshot: async () => {
        await Promise.resolve()
        return { ...healthySnapshot, rssBytes: 2_000 }
      },
      collect: async (synchronous: boolean) => {
        calls.push(synchronous)
        await Promise.resolve()
      },
      env,
    }

    const results = await Promise.all([
      SessionMemoryPressure.maybeCollect({ ...input, sessionID: "session_a" }),
      SessionMemoryPressure.maybeCollect({ ...input, sessionID: "session_b" }),
    ])

    expect(results.map((result) => result.decision.action)).toEqual(["critical", "critical"])
    expect(calls).toEqual([false])
  })

  test("treats JavaScript heap and external allocations as critical pressure", () => {
    const thresholds = SessionMemoryPressure.resolveThresholds(env, healthySnapshot)

    expect(
      SessionMemoryPressure.decide({
        snapshot: { ...healthySnapshot, heapUsedBytes: 2_000 },
        thresholds,
        now: 1_500,
        lastGCAt: 0,
        gcAvailable: true,
      }).action,
    ).toBe("critical")
    expect(
      SessionMemoryPressure.decide({
        snapshot: { ...healthySnapshot, externalBytes: 2_000 },
        thresholds,
        now: 1_500,
        lastGCAt: 0,
        gcAvailable: true,
      }).action,
    ).toBe("critical")
  })

  test("classifies soft pressure before the critical boundary", () => {
    const thresholds = SessionMemoryPressure.resolveThresholds(env, healthySnapshot)
    expect(SessionMemoryPressure.pressureLevel({ ...healthySnapshot, heapUsedBytes: 700 }, thresholds)).toBe("soft")
    expect(SessionMemoryPressure.pressureLevel(healthySnapshot, thresholds)).toBe("normal")
  })

  test("uses cgroup high memory as the default cgroup critical threshold", () => {
    const thresholds = SessionMemoryPressure.resolveThresholds(
      {},
      {
        ...healthySnapshot,
        cgroupHighBytes: 4096,
        cgroupMaxBytes: 8192,
      },
    )

    expect(thresholds.cgroupCriticalBytes).toBe(4096)
  })
})
