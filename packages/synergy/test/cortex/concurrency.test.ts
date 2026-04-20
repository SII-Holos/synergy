import { describe, expect, test, beforeEach } from "bun:test"
import { CortexConcurrency } from "../../src/cortex/concurrency"

async function flushMicrotasks(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

describe("CortexConcurrency", () => {
  beforeEach(() => {
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

  describe("getLimit", () => {
    test("returns default limit of 8", () => {
      const limit = CortexConcurrency.getLimit("any-agent")
      expect(limit).toBe(8)
    })
  })
})
