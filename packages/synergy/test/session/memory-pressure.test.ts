import { beforeEach, describe, expect, mock, test } from "bun:test"
import { SessionMemoryPressure } from "../../src/session/memory-pressure"
import { ServiceMemory } from "../../src/observability/service-memory"

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

  test("uses synchronous GC only at Linux release boundaries without changing non-Linux behavior", async () => {
    const calls: boolean[] = []

    await SessionMemoryPressure.maybeCollect({
      phase: "session.loop.released",
      now: () => 12_000,
      snapshot: () => ({ ...healthySnapshot, platform: "linux", heapUsedBytes: 700 }),
      collect: (synchronous) => {
        calls.push(synchronous)
      },
      env,
    })
    SessionMemoryPressure.resetForTest()
    await SessionMemoryPressure.maybeCollect({
      phase: "session.loop.released",
      now: () => 12_000,
      snapshot: () => ({ ...healthySnapshot, platform: "darwin", heapUsedBytes: 700 }),
      collect: (synchronous) => {
        calls.push(synchronous)
      },
      env,
    })

    expect(calls).toEqual([true, false])
  })

  test("keeps Linux soft-pressure collection asynchronous during an active stream", async () => {
    const calls: boolean[] = []

    await SessionMemoryPressure.maybeCollect({
      phase: "llm.turn.stream.periodic",
      now: () => 12_000,
      snapshot: () => ({ ...healthySnapshot, platform: "linux", heapUsedBytes: 700 }),
      collect: (synchronous) => {
        calls.push(synchronous)
      },
      env,
    })

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

  test("forces synchronous GC only for critical pressure", async () => {
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

    expect(result.decision.action).toBe("critical_forced")
    expect(calls).toEqual([true])
  })

  test("treats JavaScript heap and external allocations as critical pressure", () => {
    const thresholds = SessionMemoryPressure.resolveThresholds(env, healthySnapshot)

    expect(
      SessionMemoryPressure.decide({
        snapshot: { ...healthySnapshot, heapUsedBytes: 2_000 },
        thresholds,
        now: 1_500,
        lastGCAt: 1_000,
        gcAvailable: true,
      }).action,
    ).toBe("critical_forced")
    expect(
      SessionMemoryPressure.decide({
        snapshot: { ...healthySnapshot, externalBytes: 2_000 },
        thresholds,
        now: 1_500,
        lastGCAt: 1_000,
        gcAvailable: true,
      }).action,
    ).toBe("critical_forced")
  })

  test("classifies soft pressure before the critical boundary", () => {
    const thresholds = SessionMemoryPressure.resolveThresholds(env, healthySnapshot)
    expect(SessionMemoryPressure.pressureLevel({ ...healthySnapshot, heapUsedBytes: 700 }, thresholds)).toBe("soft")
    expect(SessionMemoryPressure.pressureLevel(healthySnapshot, thresholds)).toBe("normal")
  })

  test("uses PSI pressure only for Linux snapshots", () => {
    const thresholds = SessionMemoryPressure.resolveThresholds(env, healthySnapshot)
    const pressure = { ...healthySnapshot, cgroupPressureSomeAvg10Ratio: 0.5 }

    expect(SessionMemoryPressure.pressureLevel({ ...pressure, platform: "linux" }, thresholds)).toBe("soft")
    expect(SessionMemoryPressure.pressureLevel({ ...pressure, platform: "darwin" }, thresholds)).toBe("normal")
  })

  test("keeps Linux cgroup reclaim opt-in", async () => {
    const originalReadCgroup = ServiceMemory.readCgroup
    const originalReclaim = ServiceMemory.reclaim
    const requests: number[] = []
    try {
      ;(ServiceMemory.readCgroup as any) = mock(() => ({ reclaimableBytes: 1024 ** 3 }))
      ;(ServiceMemory.reclaim as any) = mock(async (bytes: number) => {
        requests.push(bytes)
        return { requestedBytes: bytes, supported: true }
      })
      const signal = (enabled: boolean) => {
        SessionMemoryPressure.signalRelease({
          phase: "session.loop.released",
          now: () => 12_000,
          snapshot: () => ({ ...healthySnapshot, platform: "linux", heapUsedBytes: 700 }),
          collect: () => {},
          env: {
            ...env,
            ...(enabled ? { SYNERGY_LINUX_MEMORY_RECLAIM_ENABLED: "true" } : {}),
          },
        })
      }

      signal(false)
      await SessionMemoryPressure.flushReleaseSignalsForTest()
      SessionMemoryPressure.resetForTest()
      signal(true)
      await SessionMemoryPressure.flushReleaseSignalsForTest()

      expect(requests).toEqual([512 * 1024 * 1024])
    } finally {
      ;(ServiceMemory.readCgroup as any) = originalReadCgroup
      ;(ServiceMemory.reclaim as any) = originalReclaim
    }
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
