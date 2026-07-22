import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CortexConcurrency } from "../../src/cortex/concurrency"

const originalGlobalConcurrency = process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY

async function flushMicrotasks(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

function memorySnapshot(rssGiB: number, arrayBuffersGiB = 0) {
  return {
    rssBytes: rssGiB * 1024 ** 3,
    heapUsedBytes: 1,
    heapTotalBytes: 1,
    externalBytes: 1,
    arrayBuffersBytes: arrayBuffersGiB * 1024 ** 3,
  }
}

describe("CortexConcurrency", () => {
  beforeEach(() => {
    delete process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY
    CortexConcurrency.reset()
  })

  afterEach(() => {
    if (originalGlobalConcurrency === undefined) delete process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY
    else process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY = originalGlobalConcurrency
    CortexConcurrency.reset()
  })

  describe("acquire", () => {
    test("immediately acquires when under limit", async () => {
      const acquire = CortexConcurrency.acquire("test-agent")

      expect(CortexConcurrency.status()["test-agent"]?.running).toBe(1)

      await acquire
    })

    test("allows up to 8 concurrent acquisitions by default", async () => {
      const promises: Promise<void>[] = []
      for (let i = 0; i < 8; i++) {
        promises.push(CortexConcurrency.acquire("test-agent"))
      }
      await Promise.all(promises)

      const status = CortexConcurrency.status()
      expect(status["test-agent"].running).toBe(8)
      expect(status["test-agent"].queued).toBe(0)
    })

    test("queues when at limit", async () => {
      for (let i = 0; i < 8; i++) {
        await CortexConcurrency.acquire("test-agent")
      }

      let resolved = false
      const queuedPromise = CortexConcurrency.acquire("test-agent").then(() => {
        resolved = true
      })

      await flushMicrotasks(2)
      expect(resolved).toBe(false)

      const status = CortexConcurrency.status()
      expect(status["test-agent"].running).toBe(8)
      expect(status["test-agent"].queued).toBe(1)

      CortexConcurrency.release("test-agent")
      await queuedPromise
      expect(resolved).toBe(true)
    })

    test("different agents have separate limits", async () => {
      CortexConcurrency.configure(16)
      for (let i = 0; i < 8; i++) {
        await CortexConcurrency.acquire("agent-a")
      }
      for (let i = 0; i < 8; i++) {
        await CortexConcurrency.acquire("agent-b")
      }

      const status = CortexConcurrency.status()
      expect(status["agent-a"].running).toBe(8)
      expect(status["agent-b"].running).toBe(8)
    })

    test("keeps the configured global limit under critical memory pressure", async () => {
      CortexConcurrency.configure(3)
      CortexConcurrency.setMemoryProbeForTest(() => memorySnapshot(10, 9))

      const resolved = [false, false, false]
      const acquisitions = ["agent-a", "agent-b", "agent-c"].map((agent, index) =>
        CortexConcurrency.acquire(agent).then(() => {
          resolved[index] = true
        }),
      )
      await flushMicrotasks(4)

      expect(resolved).toEqual([true, true, true])
      expect(CortexConcurrency.globalStatus()).toMatchObject({
        configured: 3,
        running: 3,
        effective: 3,
        memoryPressureLimit: 2,
        source: "config",
      })

      await Promise.all(acquisitions)
    })

    test("keeps the environment maximum under memory pressure", () => {
      CortexConcurrency.configure(6)
      process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY = "4"
      const critical = memorySnapshot(10, 9)

      expect(CortexConcurrency.getGlobalLimit()).toBe(4)
      expect(CortexConcurrency.getMemoryPressureLimit(critical)).toBe(2)
      expect(CortexConcurrency.globalStatus(critical)).toMatchObject({
        configured: 6,
        environment: 4,
        effective: 4,
        memoryPressureLimit: 2,
        source: "environment",
      })
    })

    test("reports memory pressure recommendations without changing the default limit", () => {
      expect(CortexConcurrency.getGlobalLimit()).toBe(8)
      expect(CortexConcurrency.getMemoryPressureLimit(memorySnapshot(1))).toBeUndefined()
      expect(CortexConcurrency.getMemoryPressureLimit(memorySnapshot(1, 1.1))).toBe(4)
      expect(CortexConcurrency.getMemoryPressureLimit(memorySnapshot(1, 2.1))).toBe(2)
    })

    test("raising the configured limit wakes queued tasks", async () => {
      CortexConcurrency.configure(2)
      await CortexConcurrency.acquire("agent-a")
      await CortexConcurrency.acquire("agent-b")

      let resolved = false
      const queued = CortexConcurrency.acquire("agent-c").then(() => {
        resolved = true
      })
      await flushMicrotasks(2)
      expect(resolved).toBe(false)

      CortexConcurrency.configure(3)
      await queued
      expect(resolved).toBe(true)
      expect(CortexConcurrency.globalStatus().running).toBe(3)
    })

    test("lowering the configured limit preserves running tasks and blocks new ones", async () => {
      CortexConcurrency.configure(4)
      await Promise.all([
        CortexConcurrency.acquire("agent-a"),
        CortexConcurrency.acquire("agent-b"),
        CortexConcurrency.acquire("agent-c"),
        CortexConcurrency.acquire("agent-d"),
      ])

      CortexConcurrency.configure(2)
      let resolved = false
      const queued = CortexConcurrency.acquire("agent-e").then(() => {
        resolved = true
      })
      await flushMicrotasks(2)

      expect(CortexConcurrency.globalStatus()).toMatchObject({ running: 4, effective: 2 })
      expect(resolved).toBe(false)

      CortexConcurrency.release("agent-a")
      CortexConcurrency.release("agent-b")
      CortexConcurrency.release("agent-c")
      await queued
      expect(resolved).toBe(true)
      expect(CortexConcurrency.globalStatus().running).toBe(2)
    })
  })

  describe("release", () => {
    test("decrements running count", async () => {
      await CortexConcurrency.acquire("test-agent")
      await CortexConcurrency.acquire("test-agent")

      let status = CortexConcurrency.status()
      expect(status["test-agent"].running).toBe(2)

      CortexConcurrency.release("test-agent")
      status = CortexConcurrency.status()
      expect(status["test-agent"].running).toBe(1)
    })

    test("releases to waiting task in queue", async () => {
      for (let i = 0; i < 8; i++) {
        await CortexConcurrency.acquire("test-agent")
      }

      let queuedResolved = false
      const queuedPromise = CortexConcurrency.acquire("test-agent").then(() => {
        queuedResolved = true
      })

      await flushMicrotasks(2)
      expect(queuedResolved).toBe(false)

      let status = CortexConcurrency.status()
      expect(status["test-agent"].running).toBe(8)
      expect(status["test-agent"].queued).toBe(1)

      CortexConcurrency.release("test-agent")
      await queuedPromise
      expect(queuedResolved).toBe(true)

      status = CortexConcurrency.status()
      expect(status["test-agent"].running).toBe(8)
      expect(status["test-agent"].queued).toBe(0)
    })

    test("does not go below zero", () => {
      CortexConcurrency.release("nonexistent")
      const status = CortexConcurrency.status()
      expect(status["nonexistent"]?.running ?? 0).toBe(0)
    })
  })

  describe("status", () => {
    test("returns empty object when no acquisitions", () => {
      const status = CortexConcurrency.status()
      expect(Object.keys(status)).toHaveLength(0)
    })

    test("tracks multiple agents", async () => {
      await CortexConcurrency.acquire("agent-a")
      await CortexConcurrency.acquire("agent-a")
      await CortexConcurrency.acquire("agent-b")

      const status = CortexConcurrency.status()
      expect(status["agent-a"].running).toBe(2)
      expect(status["agent-b"].running).toBe(1)
    })
  })

  describe("reset", () => {
    test("clears all state", async () => {
      await CortexConcurrency.acquire("test-agent")
      await CortexConcurrency.acquire("test-agent")

      let status = CortexConcurrency.status()
      expect(status["test-agent"].running).toBe(2)

      CortexConcurrency.reset()
      status = CortexConcurrency.status()
      expect(Object.keys(status)).toHaveLength(0)
    })
  })

  describe("memory pressure limit", () => {
    test("reports normal, soft, and critical memory limits", () => {
      expect(CortexConcurrency.getMemoryPressure(memorySnapshot(1))).toEqual({ limit: null, reason: "normal" })
      expect(CortexConcurrency.getMemoryPressure(memorySnapshot(1, 1.1))).toEqual({
        limit: 4,
        reason: "memory_pressure",
      })
      expect(CortexConcurrency.getMemoryPressure(memorySnapshot(1, 2.1))).toEqual({
        limit: 2,
        reason: "critical_memory_pressure",
      })
    })
  })

  describe("getLimit", () => {
    test("returns the fixed per-agent limit of 8", () => {
      expect(CortexConcurrency.getLimit("any-agent")).toBe(8)
    })
  })
})
