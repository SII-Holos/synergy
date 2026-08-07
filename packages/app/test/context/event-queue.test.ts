import { describe, expect, test } from "bun:test"
import {
  EVENT_QUEUE_CAP,
  HIDDEN_FLUSH_MS,
  VISIBLE_FLUSH_MS,
  createEventQueue,
  shouldProbe,
  type EventQueue,
  type EventQueueOptions,
} from "../../src/context/event-queue"

type Recorded = { directory: string; payload: unknown }

function recordedPayload(type: string, properties: Record<string, unknown>) {
  return { type, properties }
}

function createHarness(overrides?: Partial<EventQueueOptions>) {
  const emitted: Recorded[] = []
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  let hidden = false
  let nowValue = 0

  const queue = createEventQueue({
    emit: (directory, payload) => {
      emitted.push({ directory, payload })
    },
    isHidden: () => hidden,
    batch: <T>(fn: () => T) => fn(),
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms })
    },
    now: () => nowValue,
    ...overrides,
  })

  return {
    queue,
    emitted,
    scheduled,
    setHidden: (value: boolean) => {
      hidden = value
    },
    setNow: (value: number) => {
      nowValue = value
    },
    runScheduled: () => {
      const pending = scheduled.splice(0)
      for (const entry of pending) entry.fn()
    },
  }
}

function stateEvent(type: string, sessionID: string, extra: Record<string, unknown> = {}) {
  return recordedPayload(type, { sessionID, ...extra })
}

describe("createEventQueue cadence", () => {
  test("visible cadence schedules flush at 16ms and emits in push order", () => {
    const harness = createHarness()

    harness.queue.push("global", stateEvent("session.status", "ses_1"))
    expect(harness.scheduled).toHaveLength(1)
    expect(harness.scheduled[0].ms).toBe(VISIBLE_FLUSH_MS)

    harness.queue.push("global", stateEvent("session.inbox.updated", "ses_2"))
    harness.runScheduled()

    expect(harness.emitted.map((entry) => entry.payload)).toEqual([
      stateEvent("session.status", "ses_1"),
      stateEvent("session.inbox.updated", "ses_2"),
    ])
  })

  test("hidden cadence schedules flush at 1000ms", () => {
    const harness = createHarness()
    harness.setHidden(true)

    harness.queue.push("global", stateEvent("session.status", "ses_1"))
    expect(harness.scheduled).toHaveLength(1)
    expect(harness.scheduled[0].ms).toBe(HIDDEN_FLUSH_MS)
  })

  test("cadence returns to 16ms after visibility flips back to visible", () => {
    const harness = createHarness()
    harness.setHidden(true)
    harness.queue.push("global", stateEvent("session.status", "ses_1"))
    harness.runScheduled()

    harness.setHidden(false)
    harness.queue.push("global", stateEvent("session.status", "ses_2"))
    expect(harness.scheduled).toHaveLength(1)
    expect(harness.scheduled[0].ms).toBe(VISIBLE_FLUSH_MS)
  })
})

describe("createEventQueue hidden delta coalescing", () => {
  const delta = (partID: string, text: string, kind = "text") =>
    recordedPayload("message.part.delta", {
      sessionID: "ses_1",
      messageID: "msg_1",
      partID,
      kind,
      delta: text,
    })

  test("merges three deltas for the same part into one synthesized delta on flush", () => {
    const harness = createHarness()
    harness.setHidden(true)

    harness.queue.push("global", delta("part_1", "a"))
    harness.queue.push("global", delta("part_1", "b"))
    harness.queue.push("global", delta("part_1", "c", "reasoning"))
    harness.runScheduled()

    expect(harness.emitted).toEqual([
      {
        directory: "global",
        payload: recordedPayload("message.part.delta", {
          sessionID: "ses_1",
          messageID: "msg_1",
          partID: "part_1",
          kind: "reasoning",
          delta: "abc",
        }),
      },
    ])
  })

  test("keeps distinct parts separate and preserves insertion order", () => {
    const harness = createHarness()
    harness.setHidden(true)

    harness.queue.push("global", delta("part_1", "a"))
    harness.queue.push("global", delta("part_2", "x"))
    harness.runScheduled()

    expect(harness.emitted.map((entry) => entry.payload)).toEqual([
      recordedPayload("message.part.delta", {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "part_1",
        kind: "text",
        delta: "a",
      }),
      recordedPayload("message.part.delta", {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "part_2",
        kind: "text",
        delta: "x",
      }),
    ])
  })

  test("a checkpoint for the part drops the pending delta and emits the checkpoint", () => {
    const harness = createHarness()
    harness.setHidden(true)

    harness.queue.push("global", delta("part_1", "a"))
    harness.queue.push("global", delta("part_1", "b"))
    harness.queue.push(
      "global",
      recordedPayload("message.part.updated", {
        part: { id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text" },
        delta: "ab",
      }),
    )
    harness.runScheduled()

    expect(harness.emitted).toEqual([
      {
        directory: "global",
        payload: recordedPayload("message.part.updated", {
          part: { id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text" },
          delta: "ab",
        }),
      },
    ])
  })

  test("visible mode does not coalesce deltas and emits each one", () => {
    const harness = createHarness()

    harness.queue.push("global", delta("part_1", "a"))
    harness.queue.push("global", delta("part_1", "b"))
    harness.runScheduled()

    expect(harness.emitted).toEqual([
      { directory: "global", payload: delta("part_1", "a") },
      { directory: "global", payload: delta("part_1", "b") },
    ])
  })
})

describe("createEventQueue capacity", () => {
  test("flushes immediately when the queue reaches the cap and keeps every state event", () => {
    const harness = createHarness()
    // Fill with unique non-coalesced events plus one pending hidden delta.
    harness.setHidden(true)
    harness.queue.push(
      "global",
      recordedPayload("message.part.delta", {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "part_1",
        kind: "text",
        delta: "d",
      }),
    )

    for (let i = 0; i < EVENT_QUEUE_CAP - 1; i++) {
      harness.queue.push("global", stateEvent("session.updated", `ses_${i}`))
    }
    // queue.length + pendingDelta.size is now at the cap; the next push must
    // flush before enqueueing. The triggering event itself lands in the next
    // batch, so run the scheduled flush to emit it too.
    harness.queue.push("global", stateEvent("session.updated", "ses_final"))
    harness.runScheduled()

    const stateEmitted = harness.emitted.filter(
      (entry) => (entry.payload as { type?: string }).type === "session.updated",
    )
    expect(stateEmitted).toHaveLength(EVENT_QUEUE_CAP)
    expect(
      stateEmitted.map((entry) => (entry.payload as { properties: { sessionID: string } }).properties.sessionID),
    ).toEqual([...Array.from({ length: EVENT_QUEUE_CAP - 1 }, (_, i) => `ses_${i}`), "ses_final"])

    // The synthetic delta was flushed ahead of the state events.
    expect((harness.emitted[0].payload as { type?: string }).type).toBe("message.part.delta")
    expect(harness.emitted[0].payload).toEqual(
      recordedPayload("message.part.delta", {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "part_1",
        kind: "text",
        delta: "d",
      }),
    )
  })
})

describe("createEventQueue coalescing", () => {
  test("same-key session.status events emit only the latest", () => {
    const harness = createHarness()

    harness.queue.push("global", stateEvent("session.status", "ses_1", { status: "busy" }))
    harness.queue.push("global", stateEvent("session.status", "ses_1", { status: "idle" }))
    harness.queue.push("global", stateEvent("session.status", "ses_2", { status: "busy" }))
    harness.runScheduled()

    expect(harness.emitted.map((entry) => entry.payload)).toEqual([
      stateEvent("session.status", "ses_1", { status: "idle" }),
      stateEvent("session.status", "ses_2", { status: "busy" }),
    ])
  })

  test("session.status keys differ per directory", () => {
    const harness = createHarness()

    harness.queue.push("global", stateEvent("session.status", "ses_1"))
    harness.queue.push("scope-a", stateEvent("session.status", "ses_1"))
    harness.runScheduled()

    expect(harness.emitted.map((entry) => entry.directory)).toEqual(["global", "scope-a"])
    expect(harness.emitted).toHaveLength(2)
  })

  test("message.part.updated coalesces per part", () => {
    const harness = createHarness()

    const partUpdate = (id: string, delta: string) =>
      recordedPayload("message.part.updated", {
        part: { id, messageID: "msg_1", sessionID: "ses_1", type: "text" },
        delta,
      })
    harness.queue.push("global", partUpdate("part_1", "a"))
    harness.queue.push("global", partUpdate("part_1", "ab"))
    harness.queue.push("global", partUpdate("part_2", "x"))
    harness.runScheduled()

    expect(harness.emitted.map((entry) => entry.payload)).toEqual([
      partUpdate("part_1", "ab"),
      partUpdate("part_2", "x"),
    ])
  })
})

describe("createEventQueue flush idempotence and dispose", () => {
  test("flush is idempotent and clears the pending timer", () => {
    const harness = createHarness()
    harness.queue.push("global", stateEvent("session.status", "ses_1"))

    harness.runScheduled()
    const scheduledAfterFlush = harness.scheduled.length
    harness.queue.flush()

    expect(harness.scheduled).toHaveLength(scheduledAfterFlush)
    expect(harness.emitted).toHaveLength(1)
    expect(harness.queue.flush()).toBeUndefined()
    expect(harness.emitted).toHaveLength(1)
  })

  test("dispose flushes pending events and makes push a no-op", () => {
    const harness = createHarness()
    harness.queue.push("global", stateEvent("session.status", "ses_1"))

    harness.queue.dispose()
    harness.queue.push("global", stateEvent("session.status", "ses_2"))
    harness.queue.flush()

    expect(harness.emitted).toHaveLength(1)
    expect(harness.emitted[0].payload).toEqual(stateEvent("session.status", "ses_1"))
  })

  test("elapsed time reduces the scheduled delay", () => {
    const harness = createHarness()
    harness.queue.push("global", stateEvent("session.status", "ses_1"))
    harness.runScheduled()
    harness.setNow(10)

    harness.queue.push("global", stateEvent("session.status", "ses_2"))
    expect(harness.scheduled[0].ms).toBe(Math.max(0, VISIBLE_FLUSH_MS - 10))
  })
})

describe("shouldProbe", () => {
  test("probes only when visible and connected", () => {
    expect(shouldProbe("visible", true)).toBe(true)
    expect(shouldProbe("visible", false)).toBe(false)
    expect(shouldProbe("hidden", true)).toBe(false)
    expect(shouldProbe("hidden", false)).toBe(false)
  })
})

describe("createEventQueue wiring", () => {
  test("uses real timers when no schedule is injected", async () => {
    const emitted: Recorded[] = []
    const queue: EventQueue = createEventQueue({
      emit: (directory, payload) => {
        emitted.push({ directory, payload })
      },
      isHidden: () => false,
      batch: <T>(fn: () => T) => fn(),
    })

    queue.push("global", stateEvent("session.status", "ses_1"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(emitted).toHaveLength(1)
    queue.dispose()
  })
})
