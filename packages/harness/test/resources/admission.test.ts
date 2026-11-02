import { describe, expect, test } from "bun:test"
import { MemoryAdmission } from "../../src/resources/admission"
import type { ResourceSnapshot } from "../../src/resources/schema"

const MiB = 1024 ** 2
function snapshot(available = 2048 * MiB, sampledAt = 0): ResourceSnapshot {
  return {
    sampledAt,
    quality: "complete",
    pressure: "normal",
    domains: [{ kind: "physical", capacityBytes: 8192 * MiB, availableBytes: available }],
    processRssBytes: 100 * MiB,
  }
}

describe("memory admission", () => {
  test("reassesses waiting work when a worker becomes reusable", async () => {
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => 0 })
    gate.update(snapshot(100))
    let estimate = 200
    const waiting = gate.acquire({ owner: "a", bytes: estimate, estimate: () => estimate })
    expect(gate.status().queued).toBe(1)
    estimate = 40
    gate.update(snapshot(100, 1))
    const lease = await waiting
    expect(gate.status().reservedBytes).toBe(40)
    lease.release()
  })
  test("bounds retained queue payload centrally without expiring admitted waiters", async () => {
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => 0 })
    gate.setLimit("model", 1, { maxQueued: 1, maxQueuedBytes: 10 })
    gate.update(snapshot(100))
    const running = await gate.acquire({ owner: "a", bytes: 1, pool: "model" })
    await expect(gate.acquire({ owner: "b", bytes: 1, retainedBytes: 11, pool: "model" })).rejects.toThrow("queue")
    const waiting = gate.acquire({ owner: "b", bytes: 1, retainedBytes: 10, pool: "model" })
    await expect(gate.acquire({ owner: "c", bytes: 1, pool: "model" })).rejects.toThrow("queue")
    const revision = gate.status().revision
    running.release()
    const next = await waiting
    expect(gate.status().revision).toBeGreaterThan(revision)
    next.release()
  })

  test("reserves atomically across bursts and cancels a queued request without spending capacity", async () => {
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => 0 })
    gate.update(snapshot(100))
    const first = await gate.acquire({ owner: "a", bytes: 60 })
    const abort = new AbortController()
    const waiting = gate.acquire({ owner: "b", bytes: 60, signal: abort.signal })
    expect(gate.status().reservedBytes).toBe(60)
    expect(gate.status().queued).toBe(1)
    abort.abort(new Error("cancelled"))
    await expect(waiting).rejects.toThrow("cancelled")
    first.release()
    expect(gate.status().reservedBytes).toBe(0)
    expect(gate.status().queued).toBe(0)
  })

  test("a checkpoint reduces future commitments only after a newer sample", async () => {
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => 0 })
    gate.update(snapshot(100))
    const lease = await gate.acquire({ owner: "a", bytes: 80 })
    lease.checkpoint(20)
    expect(gate.status().reservedBytes).toBe(80)
    gate.update(snapshot(40, 1))
    expect(gate.status().reservedBytes).toBe(20)
    expect(gate.status().headroomBytes).toBe(20)
    lease.release()
    lease.release()
    expect(gate.status().reservedBytes).toBe(0)
  })

  test("zero admission recovers independently of task completion and does not kill an active lease", async () => {
    let now = 0
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => now })
    gate.update(snapshot(100))
    const active = await gate.acquire({ owner: "a", bytes: 20 })
    gate.update({ ...snapshot(100), pressure: "critical" })
    const waiting = gate.acquire({ owner: "b", bytes: 20 })
    expect(gate.status().state).toBe("blocked")
    expect(gate.status().active).toBe(1)
    now = 1
    gate.update(snapshot(100, now))
    now = 10_001
    gate.update(snapshot(100, now))
    const next = await waiting
    expect(gate.status().state).toBe("recovering")
    active.release()
    next.release()
  })

  test("honors every domain, keeps soft pressure distinct, and rejects only a proven impossible minimum", async () => {
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => 0 })
    gate.update({
      ...snapshot(100),
      domains: [...snapshot(100).domains, { kind: "cgroup", capacityBytes: 30, availableBytes: 10 }],
    })
    const abort = new AbortController()
    const waiting = gate.acquire({ owner: "a", bytes: 40, minimumBytes: 5, signal: abort.signal })
    expect(gate.status().queued).toBe(1)
    await expect(gate.acquire({ owner: "b", bytes: 40, minimumBytes: 31 })).rejects.toThrow("hard capacity")
    abort.abort()
    await expect(waiting).rejects.toThrow()
  })

  test("rotates root owners and combines execution slots with memory admission", async () => {
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => 0 })
    gate.setLimit("model", 1)
    gate.update(snapshot(100))
    const running = await gate.acquire({ owner: "a", bytes: 1, pool: "model" })
    const order: string[] = []
    const tasks = ["a", "a", "b"].map((owner) =>
      gate.acquire({ owner, bytes: 1, pool: "model" }).then((lease) => {
        order.push(owner)
        lease.release()
      }),
    )
    running.release()
    await Promise.all(tasks)
    expect(order).toEqual(["b", "a", "a"])
  })

  test("a stale required sample blocks new work; optional missing probes do not", async () => {
    let now = 0
    const gate = new MemoryAdmission({ reserveBytes: 0, now: () => now })
    gate.update({ ...snapshot(100), quality: "partial" })
    const lease = await gate.acquire({ owner: "a", bytes: 1 })
    now = 20_000
    expect(gate.status().reason).toBe("stale_sample")
    lease.release()
    gate.close()
    await expect(gate.acquire({ owner: "a", bytes: 1 })).rejects.toThrow("closed")
  })
})
