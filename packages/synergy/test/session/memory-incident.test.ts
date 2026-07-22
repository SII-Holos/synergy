import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityStore } from "../../src/observability/store"
import { SessionMemoryIncident } from "../../src/session/memory-incident"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

describe("SessionMemoryIncident", () => {
  beforeEach(() => {
    resetObservabilityHome()
    SessionMemoryIncident.resetForTest()
  })
  afterEach(() => cleanupObservabilityHomes())

  test("recognizes runtime allocation failures", () => {
    expect(SessionMemoryIncident.isOutOfMemory(new RangeError("Out of memory"))).toBe(true)
    expect(SessionMemoryIncident.isOutOfMemory(new Error("Out of memory"))).toBe(true)
    expect(SessionMemoryIncident.isOutOfMemory(new Error("Array buffer allocation failed"))).toBe(true)
    expect(
      SessionMemoryIncident.isOutOfMemory(
        Object.assign(new Error("wrapped"), { cause: new Error("Cannot allocate memory") }),
      ),
    ).toBe(true)
    expect(SessionMemoryIncident.isOutOfMemory(new Error("network failed"))).toBe(false)
  })

  test("bounds nearby samples, live spans, cache entries, and active turns", () => {
    const incident = SessionMemoryIncident.build({
      occurredAt: 100,
      current: {
        rssBytes: 1,
        heapUsedBytes: 2,
        heapTotalBytes: 3,
        externalBytes: 4,
        arrayBuffersBytes: 5,
      },
      gc: { decision: { action: "critical", reason: "critical_pressure", critical: true } },
      resources: Array.from({ length: 20 }, (_, index) => ({ time: index, rssBytes: index })),
      spans: Array.from({ length: 30 }, (_, index) => ({ name: `span-${index}`, ageMs: index })),
      cache: {
        totalBytes: 100,
        entryCount: 30,
        activeCount: 30,
        hits: 1,
        misses: 2,
        evictions: 3,
        protectedOverbudget: 4,
        entries: Array.from({ length: 30 }, (_, index) => ({ estimatedBytes: index })),
      },
      turns: Array.from({ length: 30 }, (_, index) => ({ ageMs: index, requestBytes: index })),
    })

    expect(incident.resources).toHaveLength(6)
    expect(incident.spans).toHaveLength(20)
    expect(incident.cache.entries).toHaveLength(20)
    expect(incident.turns).toHaveLength(20)
    expect(JSON.stringify(incident)).not.toContain("sessionID")
    expect(JSON.stringify(incident)).not.toContain("messageID")
  })

  test("persists one bounded event and issue for an allocation failure", async () => {
    const incident = await SessionMemoryIncident.capture({
      error: new RangeError("Out of memory"),
      sessionID: "ses_incident",
      messageID: "msg_incident",
    })
    await SessionMemoryIncident.capture({
      error: new RangeError("Out of memory"),
      sessionID: "ses_duplicate",
    })
    ObservabilityStore.flush()

    expect(incident).toBeDefined()
    expect(ObservabilityStore.queryEvents({ type: "process.memory.oom_incident" })).toHaveLength(1)
    expect(
      ObservabilityStore.queryIssues({ status: "open" }).filter((issue) => issue.code === "PERF_PROCESS_OUT_OF_MEMORY"),
    ).toHaveLength(1)
  })

  test("allows a later capture when an earlier attempt fails", async () => {
    const { ObservabilityEvents } = await import("../../src/observability/events")
    const originalEmit = ObservabilityEvents.emit
    let attempts = 0
    ObservabilityEvents.emit = (async (...args: Parameters<typeof originalEmit>) => {
      attempts++
      if (attempts === 1) throw new Error("storage unavailable")
      return originalEmit(...args)
    }) as typeof originalEmit

    try {
      await expect(SessionMemoryIncident.capture({ error: new RangeError("Out of memory"), now: 100 })).rejects.toThrow(
        "storage unavailable",
      )
      const incident = await SessionMemoryIncident.capture({ error: new RangeError("Out of memory"), now: 101 })
      expect(incident).toBeDefined()
      expect(attempts).toBe(2)
    } finally {
      ObservabilityEvents.emit = originalEmit
    }
  })
})
