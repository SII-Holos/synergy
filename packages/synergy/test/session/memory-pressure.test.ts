import { beforeEach, describe, expect, test } from "bun:test"
import { SessionMemoryPressure } from "../../src/session/memory-pressure"

const env = {
  SYNERGY_SESSION_GC_MIN_INTERVAL_MS: "10000",
  SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES: "1000",
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
