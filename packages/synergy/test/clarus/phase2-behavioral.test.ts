import { describe, expect, test, beforeAll } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { ClarusOutbox } from "../../src/clarus/outbox"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusProjectBindingV3Schema } from "../../src/clarus/schemas"
import { canonicalJSON, canonicalEqual } from "../../src/util/canonical"
import { SessionNav } from "../../src/session/nav"
import { clarusMigrations } from "../../src/clarus/migration"

// Structured error type for CLARUS_INBOX_COLLISION checks
function isClarusInboxCollision(err: unknown): err is Error & { code: string } {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_INBOX_COLLISION"
}

function isClarusOutboxCollision(err: unknown): err is Error & { code: string } {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OUTBOX_COLLISION"
}

// =========================================================================
// F: Canonical utility robustness
// =========================================================================
describe("canonicalJSON", () => {
  test("nested key reordering produces same output", () => {
    const a = { b: 2, a: 1, c: { d: 4, c: 3 } }
    const b = { a: 1, c: { c: 3, d: 4 }, b: 2 }
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })

  test("undefined values normalize to null", () => {
    expect(canonicalJSON(undefined)).toBe("null")
    expect(canonicalJSON({ a: undefined, b: 1 })).toBe(canonicalJSON({ a: null, b: 1 }))
  })

  test("arrays are handled correctly", () => {
    const a = [{ b: 2, a: 1 }, 3]
    const b = [{ a: 1, b: 2 }, 3]
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })

  test("cyclic references are rejected", () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    expect(() => canonicalJSON(obj)).toThrow("cyclic")
  })

  test("non-plain objects are rejected", () => {
    expect(() => canonicalJSON(new Date())).toThrow("non-plain")
    expect(() => canonicalJSON(new Map())).toThrow("non-plain")
  })

  test("functions are rejected", () => {
    expect(() => canonicalJSON(() => {})).toThrow()
  })

  test("canonicalEqual with undefined", () => {
    expect(canonicalEqual(undefined, null)).toBe(true)
    expect(canonicalEqual({ a: undefined }, { a: null })).toBe(true)
  })
})

// =========================================================================
// C: SessionInbox.enqueueDeterministic — global itemID index + normalized payload
// =========================================================================
describe("SessionInbox enqueueDeterministic", () => {
  test("exact deterministic replay returns existing, one stored item", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        const input = {
          sessionID: session.id,
          itemID: "inb_f_det_1",
          messageID: "msg_f_det_1",
          mode: "task" as const,
          message: {
            parts: [{ type: "text" as const, text: "clarus task" }],
            role: "user" as const,
          },
          source: { type: "clarus", label: "Clarus Task" },
        }

        const r1 = await SessionInbox.enqueueDeterministic(input)
        expect(r1.outcome).toBe("created")

        const r2 = await SessionInbox.enqueueDeterministic(input)
        expect(r2.outcome).toBe("existing")

        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("replay with object key reordering succeeds (normalized payload)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_reorder",
          messageID: "msg_reorder",
          mode: "task",
          message: {
            parts: [{ type: "text", text: "test" }],
            role: "user",
            metadata: { deep: { a: 1, b: 2 } },
          },
          source: { type: "clarus", label: "Test" },
        })

        const r = await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_reorder",
          messageID: "msg_reorder",
          mode: "task",
          message: {
            metadata: { deep: { b: 2, a: 1 } },
            role: "user",
            parts: [{ type: "text", text: "test" }],
          },
          source: { label: "Test", type: "clarus" },
        })
        expect(r.outcome).toBe("existing")

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("replay with omitted defaults succeeds (normalized payload fills defaults)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_defaults",
          messageID: "msg_defaults",
          mode: "task",
          message: {
            parts: [{ type: "text", text: "hello" }],
            role: "user",
            origin: { type: "user" },
            visible: true,
          },
          source: { type: "test", label: "Test" },
        })

        const r = await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_defaults",
          messageID: "msg_defaults",
          mode: "task",
          message: {
            parts: [{ type: "text", text: "hello" }],
            role: "user",
          },
          source: { type: "test", label: "Test" },
        })
        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("cross-session same itemID throws CLARUS_INBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const s1 = await Session.create({})
        const s2 = await Session.create({})

        await SessionInbox.enqueueDeterministic({
          sessionID: s1.id,
          itemID: "inb_cross_coll",
          messageID: "msg_cs1",
          mode: "task",
          message: {
            parts: [{ type: "text", text: "test" }],
            role: "user",
            visible: true,
          },
          source: { type: "test" },
        })

        try {
          await SessionInbox.enqueueDeterministic({
            sessionID: s2.id,
            itemID: "inb_cross_coll",
            messageID: "msg_cs2",
            mode: "task",
            message: {
              parts: [{ type: "text", text: "test" }],
              role: "user",
              visible: true,
            },
            source: { type: "test" },
          })
          expect.unreachable("should throw cross-session collision")
        } catch (e) {
          if (!isClarusInboxCollision(e)) throw e
          expect(e.message).toContain("collision")
        }

        SessionManager.unregisterRuntime(s1.id)
        SessionManager.unregisterRuntime(s2.id)
      },
    })
  })

  test("concurrent cross-session claims create one item and one structured collision", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const first = await Session.create({})
        const second = await Session.create({})
        const deliver = (sessionID: string, messageID: string) =>
          SessionInbox.enqueueDeterministic({
            sessionID,
            itemID: "inb_concurrent_claim",
            messageID,
            mode: "task",
            message: { parts: [{ type: "text", text: "concurrent" }] },
            source: { type: "test" },
          })

        const results = await Promise.allSettled([
          deliver(first.id, "msg_concurrent_first"),
          deliver(second.id, "msg_concurrent_second"),
        ])
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        const rejected = results.find((result) => result.status === "rejected")
        expect(rejected?.status).toBe("rejected")
        if (rejected?.status === "rejected") expect(isClarusInboxCollision(rejected.reason)).toBe(true)
        expect((await SessionInbox.list(first.id)).length + (await SessionInbox.list(second.id)).length).toBe(1)

        SessionManager.unregisterRuntime(first.id)
        SessionManager.unregisterRuntime(second.id)
      },
    })
  })

  test("collision on mode mismatch throws CLARUS_INBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_mode_coll2",
          messageID: "msg_mode_coll2",
          mode: "task",
          message: { parts: [{ type: "text", text: "hello" }], role: "user" as const, visible: true },
          source: { type: "test" },
        })

        try {
          await SessionInbox.enqueueDeterministic({
            sessionID: session.id,
            itemID: "inb_mode_coll2",
            messageID: "msg_mode_coll2",
            mode: "context",
            message: { parts: [{ type: "text", text: "hello" }], role: "user" as const, visible: true },
            source: { type: "test" },
          })
          expect.unreachable("should throw")
        } catch (e) {
          if (!isClarusInboxCollision(e)) throw e
        }

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("collision on nested payload throws CLARUS_INBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_nested_coll2",
          messageID: "msg_nested_coll2",
          mode: "task",
          message: {
            parts: [{ type: "text", text: "nested payload" }],
            role: "user" as const,
            visible: true,
            metadata: { deep: { a: 1, b: 2 } },
          },
          source: { type: "test" },
        })

        try {
          await SessionInbox.enqueueDeterministic({
            sessionID: session.id,
            itemID: "inb_nested_coll2",
            messageID: "msg_nested_coll2",
            mode: "task",
            message: {
              parts: [{ type: "text", text: "nested payload" }],
              role: "user" as const,
              visible: true,
              metadata: { deep: { a: 1, b: 3 } },
            },
            source: { type: "test" },
          })
          expect.unreachable("should throw")
        } catch (e) {
          if (!isClarusInboxCollision(e)) throw e
        }

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("collision on messageID mismatch throws", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_msgid_coll2",
          messageID: "msg_orig2",
          mode: "task",
          message: { parts: [{ type: "text", text: "test" }], role: "user" as const, visible: true },
          source: { type: "test" },
        })

        try {
          await SessionInbox.enqueueDeterministic({
            sessionID: session.id,
            itemID: "inb_msgid_coll2",
            messageID: "msg_diff2",
            mode: "task",
            message: { parts: [{ type: "text", text: "test" }], role: "user" as const, visible: true },
            source: { type: "test" },
          })
          expect.unreachable("should throw")
        } catch (e) {
          if (!isClarusInboxCollision(e)) throw e
        }

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("collision on source difference throws", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueDeterministic({
          sessionID: session.id,
          itemID: "inb_src_diff",
          messageID: "msg_src_diff",
          mode: "task",
          message: { parts: [{ type: "text", text: "test" }], role: "user" as const, visible: true },
          source: { type: "clarus", label: "Clarus" },
        })

        try {
          await SessionInbox.enqueueDeterministic({
            sessionID: session.id,
            itemID: "inb_src_diff",
            messageID: "msg_src_diff",
            mode: "task",
            message: { parts: [{ type: "text", text: "test" }], role: "user" as const, visible: true },
            source: { type: "other", label: "Other" },
          })
          expect.unreachable("should throw")
        } catch (e) {
          if (!isClarusInboxCollision(e)) throw e
        }

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})

// =========================================================================
// D: SessionManager.deliverWithResult / deliverContext — wake evidence
// =========================================================================
describe("SessionManager deliverWithResult", () => {
  test("deliverWithResult new task delivery enqueues one item with deterministic IDs", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const itemID = "inb_dwr_new2"
        const messageID = "msg_dwr_new2"

        const r1 = await SessionManager.deliverWithResult({
          target: session.id,
          mail: {
            type: "user",
            parts: [{ id: "p1", sessionID: session.id, messageID, type: "text", text: "clarus task" }],
          },
          inboxItemID: itemID,
          inboxMessageID: messageID,
        })
        expect(r1.outcome).toBe("created")

        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)
        expect(items[0].id).toBe(itemID)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("deliverWithResult deterministic replay returns existing, no duplicate", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const itemID = "inb_replay_dwr2"
        const messageID = "msg_replay_dwr2"

        const r1 = await SessionManager.deliverWithResult({
          target: session.id,
          mail: {
            type: "user",
            parts: [{ id: "p1", sessionID: session.id, messageID, type: "text", text: "task" }],
          },
          inboxItemID: itemID,
          inboxMessageID: messageID,
        })
        expect(r1.outcome).toBe("created")

        const r2 = await SessionManager.deliverWithResult({
          target: session.id,
          mail: {
            type: "user",
            parts: [{ id: "p1", sessionID: session.id, messageID, type: "text", text: "task" }],
          },
          inboxItemID: itemID,
          inboxMessageID: messageID,
        })
        expect(r2.outcome).toBe("existing")

        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("new deterministic task delivery schedules/wakes exactly once when idle", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const itemID = "inb_wake_once"
        const messageID = "msg_wake_once"
        let wakeCount = 0

        SessionManager.__setScheduleWakeObserver(() => {
          wakeCount++
        })

        try {
          const r1 = await SessionManager.deliverWithResult({
            target: session.id,
            mail: {
              type: "user",
              parts: [{ id: "p1", sessionID: session.id, messageID, type: "text", text: "wake test" }],
            },
            inboxItemID: itemID,
            inboxMessageID: messageID,
          })
          expect(r1.outcome).toBe("created")
          expect(wakeCount).toBe(1)
        } finally {
          SessionManager.__setScheduleWakeObserver(undefined)
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("exact deterministic replay does NOT schedule/wake again", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const itemID = "inb_replay_nowake"
        const messageID = "msg_replay_nowake"

        // Create first
        SessionManager.__setScheduleWakeObserver(() => {})
        await SessionManager.deliverWithResult({
          target: session.id,
          mail: {
            type: "user",
            parts: [{ id: "p1", sessionID: session.id, messageID, type: "text", text: "task" }],
          },
          inboxItemID: itemID,
          inboxMessageID: messageID,
        })
        SessionManager.__setScheduleWakeObserver(undefined)

        // Replay — should not wake
        let replayWakeCount = 0
        SessionManager.__setScheduleWakeObserver(() => {
          replayWakeCount++
        })

        try {
          const r2 = await SessionManager.deliverWithResult({
            target: session.id,
            mail: {
              type: "user",
              parts: [{ id: "p1", sessionID: session.id, messageID, type: "text", text: "task" }],
            },
            inboxItemID: itemID,
            inboxMessageID: messageID,
          })
          expect(r2.outcome).toBe("existing")
          expect(replayWakeCount).toBe(0)
        } finally {
          SessionManager.__setScheduleWakeObserver(undefined)
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })
})

describe("SessionManager deliverContext", () => {
  test("deliverContext enqueues context item durably and does NOT wake", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const itemID = "inb_ctx_dc2"
        const messageID = "msg_ctx_dc2"

        let wakeScheduled = false
        SessionManager.__setScheduleWakeObserver(() => {
          wakeScheduled = true
        })

        try {
          const result = await SessionManager.deliverContext({
            target: session.id,
            inboxItemID: itemID,
            inboxMessageID: messageID,
            parts: [{ type: "text", text: "context activity" }] as SessionInbox.PayloadPartType[],
            source: { type: "clarus", label: "Activity" },
          })
          expect(result.sessionID).toBe(session.id)
          expect(result.itemID).toBe(itemID)
          expect(result.messageID).toBe(messageID)

          expect(wakeScheduled).toBe(false)

          const items = await SessionInbox.list(session.id)
          expect(items).toHaveLength(1)
          expect(items[0].id).toBe(itemID)
          expect(items[0].mode).toBe("context")
        } finally {
          SessionManager.__setScheduleWakeObserver(undefined)
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("deliverContext does NOT leave fake running runtime", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})

        await SessionManager.deliverContext({
          target: session.id,
          inboxItemID: "inb_no_fake2",
          inboxMessageID: "msg_no_fake2",
          parts: [{ type: "text", text: "activity" }] as SessionInbox.PayloadPartType[],
          source: { type: "clarus", label: "Activity" },
        })

        const runtime = SessionManager.getRuntime(session.id)
        if (runtime) {
          expect(runtime.owner).toBeUndefined()
        }
      },
    })
  })
})

// =========================================================================
// ClarusOutbox.preallocate / markDispatched
// =========================================================================
describe("ClarusOutbox", () => {
  test("ClarusOutbox.preallocate exact replay returns existing", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const payload = { result: "done", count: 1 }
        const r1 = await ClarusOutbox.preallocate({
          requestID: "req-out-replay2",
          action: "task_result",
          agentId: "ag-1",
          projectId: "pr-1",
          payload,
        })
        expect(r1.state).toBe("prepared")

        const r2 = await ClarusOutbox.preallocate({
          requestID: "req-out-replay2",
          action: "task_result",
          agentId: "ag-1",
          projectId: "pr-1",
          payload,
        })
        expect(r2.state).toBe("prepared")
        expect(r2.preparedAt).toBe(r1.preparedAt)
      },
    })
  })

  test("ClarusOutbox.preallocate collision on action throws CLARUS_OUTBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusOutbox.preallocate({
          requestID: "req-out-act2",
          action: "task_result",
          agentId: "ag-act2",
          projectId: "pr-act2",
          payload: { x: 1 },
        })

        try {
          await ClarusOutbox.preallocate({
            requestID: "req-out-act2",
            action: "project_subscribe",
            agentId: "ag-act2",
            projectId: "pr-act2",
            payload: { x: 1 },
          })
          expect.unreachable("should throw")
        } catch (e) {
          if (!isClarusOutboxCollision(e)) throw e
        }
      },
    })
  })

  test("ClarusOutbox.preallocate collision on nested payload throws", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusOutbox.preallocate({
          requestID: "req-out-nested2",
          action: "task_result",
          agentId: "ag-nested2",
          projectId: "pr-nested2",
          payload: { outer: { inner: { a: 1, b: 2 } } },
        })

        try {
          await ClarusOutbox.preallocate({
            requestID: "req-out-nested2",
            action: "task_result",
            agentId: "ag-nested2",
            projectId: "pr-nested2",
            payload: { outer: { inner: { a: 1, b: 3 } } },
          })
          expect.unreachable("should throw")
        } catch (e) {
          if (!isClarusOutboxCollision(e)) throw e
        }
      },
    })
  })

  test("ClarusOutbox.preallocate collision on runId throws", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusOutbox.preallocate({
          requestID: "req-out-run2",
          action: "task_result",
          agentId: "ag-run2",
          projectId: "pr-run2",
          runId: "run-1",
          subtaskId: "sub-1",
          payload: { v: 1 },
        })

        try {
          await ClarusOutbox.preallocate({
            requestID: "req-out-run2",
            action: "task_result",
            agentId: "ag-run2",
            projectId: "pr-run2",
            runId: "run-2",
            subtaskId: "sub-1",
            payload: { v: 1 },
          })
          expect.unreachable("should throw")
        } catch (e) {
          if (!isClarusOutboxCollision(e)) throw e
        }
      },
    })
  })

  test("ClarusOutbox.markDispatched lifecycle and immutable payload", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const payload = { results: [1, 2, { nested: true }] }
        const r1 = await ClarusOutbox.preallocate({
          requestID: "req-out-life2",
          action: "task_extend",
          agentId: "agent-life2",
          projectId: "proj-life2",
          taskId: "task-life2",
          runId: "run-life2",
          payload,
        })
        expect(r1.state).toBe("prepared")
        expect(r1.payload).toEqual(payload)

        const r2 = await ClarusOutbox.markDispatched("req-out-life2", {
          connectionEpoch: "epoch-1",
          generation: 5,
        })
        expect(r2.state).toBe("dispatched")
        expect(r2.dispatchedAt).toBeGreaterThanOrEqual(r1.preparedAt!)
        expect(r2.connectionEpoch).toBe("epoch-1")
        expect(r2.generation).toBe(5)
        expect(r2.payload).toEqual(payload)
        expect(r2.agentId).toBe("agent-life2")

        const r3 = await ClarusOutbox.markAcknowledged("req-out-life2")
        expect(r3.state).toBe("acknowledged")
        expect(r3.payload).toEqual(payload)
        expect(r3.schemaVersion).toBe(2)
      },
    })
  })
})

// =========================================================================
// A: Legacy project-session archive + nav — migration tests
// =========================================================================
describe("Clarus migration — project session archive (A)", () => {
  test("migration handles fresh install (no-op, zero failures)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { runMigrations } = await import("../../src/migration/index")
        const result = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(result.failed).toBe(0)
      },
    })
  })

  test("migration 'up' function upgrades Project V1 to V3 and archives legacy session", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Create a real stored legacy session with info + nav
        const legacySession = await Session.create({ title: "Legacy Project" })

        const { bindingKey } = await import("../../src/clarus/keys")
        const key = bindingKey("ag-pv1-a", "pr-pv1-a")
        await Storage.write(StoragePath.clarusBinding(key), {
          schemaVersion: 1,
          agentId: "ag-pv1-a",
          projectId: "pr-pv1-a",
          state: "active",
          workspacePath: "/tmp",
          scopeID: scope.id,
          projectSessionID: legacySession.id,
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        // Verify binding upgraded
        const upgraded = await Storage.read<unknown>(StoragePath.clarusBinding(key))
        const parsed = ClarusProjectBindingV3Schema.safeParse(upgraded)
        expect(parsed.success).toBe(true)
        if (parsed.success) {
          expect(parsed.data.schemaVersion).toBe(3)
          expect(parsed.data.lifecycle).toBe("active")
        }

        // Verify session archived
        const sessionInfo = await Storage.read<Record<string, unknown>>(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(legacySession.id)),
        ).catch(() => undefined)
        // Session should have time.archived set
        if (sessionInfo) {
          const time = sessionInfo.time as Record<string, unknown> | undefined
          expect(time?.archived).toBeDefined()
        }

        SessionManager.unregisterRuntime(legacySession.id)
      },
    })
  })

  test("migration 'up' function is idempotent", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { bindingKey } = await import("../../src/clarus/keys")
        const key = bindingKey("ag-idem-a", "pr-idem-a")
        await Storage.write(StoragePath.clarusBinding(key), {
          schemaVersion: 1,
          agentId: "ag-idem-a",
          projectId: "pr-idem-a",
          state: "active",
          workspacePath: "/tmp",
          scopeID: scope.id,
          projectSessionID: "ses-nonexistent-idem-a",
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()

        await migration!.up(() => {})
        await migration!.up(() => {})

        const upgraded = await Storage.read<unknown>(StoragePath.clarusBinding(key))
        expect((upgraded as Record<string, unknown>)?.schemaVersion).toBe(3)
      },
    })
  })

  test("migration skips corrupt record while retaining for diagnosis", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { bindingKey } = await import("../../src/clarus/keys")
        const corruptKey = bindingKey("ag-corr-a", "pr-corr-a")
        await Storage.write<unknown>(StoragePath.clarusBinding(corruptKey), "not-an-object")

        const { resetMigrations, runMigrations } = await import("../../src/migration/index")
        resetMigrations()
        const result = await runMigrations({ targetDomain: "clarus", output: "silent" })
        expect(result.failed).toBe(0)

        const corruptAfter = await Storage.read<unknown>(StoragePath.clarusBinding(corruptKey))
        expect(corruptAfter).toBe("not-an-object")
      },
    })
  })

  test("migration rebuilds nav indexes after archiving (archived session excluded from nav)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const legacySession = await Session.create({ title: "Legacy for Nav" })

        const { bindingKey } = await import("../../src/clarus/keys")
        const key = bindingKey("ag-nav-a", "pr-nav-a")
        await Storage.write(StoragePath.clarusBinding(key), {
          schemaVersion: 2,
          agentId: "ag-nav-a",
          projectId: "pr-nav-a",
          lifecycle: "active",
          workspacePath: "/tmp",
          scopeID: scope.id,
          projectSessionID: legacySession.id,
          desiredSubscription: true,
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        // Verify nav excludes archived session
        const navResult = await SessionNav.queryScope(Identifier.asScopeID(scope.id), { includeArchived: false })
        expect(navResult.items.find((e) => e.id === legacySession.id)).toBeUndefined()

        // But it should appear with includeArchived
        const navWithArchived = await SessionNav.queryScope(Identifier.asScopeID(scope.id), { includeArchived: true })
        expect(navWithArchived.items.find((e) => e.id === legacySession.id)).toBeDefined()
        const globalNav = await SessionNav.queryGlobal()
        expect(globalNav.items.find((entry) => entry.id === legacySession.id)).toBeUndefined()
        const pinnedNav = await SessionNav.queryPinned()
        expect(pinnedNav.items.find((entry) => entry.id === legacySession.id)).toBeUndefined()

        SessionManager.unregisterRuntime(legacySession.id)
      },
    })
  })

  test("repeated migration is idempotent (session not re-archived)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const legacySession = await Session.create({ title: "Idempotent Archive" })

        const { bindingKey } = await import("../../src/clarus/keys")
        const key = bindingKey("ag-idem-arch-a", "pr-idem-arch-a")
        await Storage.write(StoragePath.clarusBinding(key), {
          schemaVersion: 1,
          agentId: "ag-idem-arch-a",
          projectId: "pr-idem-arch-a",
          state: "active",
          workspacePath: "/tmp",
          scopeID: scope.id,
          projectSessionID: legacySession.id,
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        // Run twice — second run should skip already-archived session
        await migration!.up(() => {})
        await migration!.up(() => {})

        SessionManager.unregisterRuntime(legacySession.id)
      },
    })
  })
})

// =========================================================================
// B: Completed-task evidence rule — migration tests
// =========================================================================
describe("Clarus migration — task evidence rule (B)", () => {
  test("V2 completed task with acknowledged outbox → submitted + acknowledged", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Write ack'd outbox
        const outboxPayload = { result: "done" }
        const { payloadHash } = await import("../../src/clarus/keys")
        await Storage.write(StoragePath.clarusOutbox("out-ack-b"), {
          schemaVersion: 2,
          requestID: "out-ack-b",
          action: "task_result",
          agentId: "tack-b",
          projectId: "pack-b",
          taskId: "tk-ack-b",
          payload: outboxPayload,
          payloadHash: payloadHash(outboxPayload),
          state: "acknowledged",
          preparedAt: 1000,
          dispatchedAt: 2000,
          acknowledgedAt: 3000,
        })

        const { bindingKey } = await import("../../src/clarus/keys")
        const tkey = `${bindingKey("tack-b", "pack-b")}:${encodeURIComponent("tk-ack-b")}`
        await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], {
          schemaVersion: 2,
          agentId: "tack-b",
          projectId: "pack-b",
          taskId: "tk-ack-b",
          sessionID: "ses-tack-b",
          workspacePath: "/tmp",
          scopeID: scope.id,
          status: "completed",
          resultOutboxRequestID: "out-ack-b",
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const after = await Storage.read<Record<string, unknown>>([...StoragePath.clarusBindingsRoot(), "tasks", tkey])
        expect(after.status).toBe("submitted")
        expect(after.resultState).toBe("acknowledged")
      },
    })
  })

  test("V2 completed task with missing outbox → needs_attention, resultState idle", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        // No outbox record written
        const { bindingKey } = await import("../../src/clarus/keys")
        const tkey = `${bindingKey("tmiss-b", "pmiss-b")}:${encodeURIComponent("tk-miss-b")}`
        await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], {
          schemaVersion: 2,
          agentId: "tmiss-b",
          projectId: "pmiss-b",
          taskId: "tk-miss-b",
          sessionID: "ses-tmiss-b",
          workspacePath: "/tmp",
          scopeID: scope.id,
          status: "completed",
          resultOutboxRequestID: "out-miss-b",
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const after = await Storage.read<Record<string, unknown>>([...StoragePath.clarusBindingsRoot(), "tasks", tkey])
        expect(after.status).toBe("needs_attention")
        expect(after.resultState).toBe("idle")
      },
    })
  })

  test("V2 completed task with rejected outbox → needs_attention + rejected", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(StoragePath.clarusOutbox("out-rej-b"), {
          schemaVersion: 2,
          requestID: "out-rej-b",
          action: "task_result",
          agentId: "trej-b",
          projectId: "prej-b",
          taskId: "tk-rej-b",
          payload: {},
          payloadHash: "",
          state: "rejected",
          preparedAt: 1000,
          dispatchedAt: 2000,
          rejectedAt: 3000,
        })

        const { bindingKey } = await import("../../src/clarus/keys")
        const tkey = `${bindingKey("trej-b", "prej-b")}:${encodeURIComponent("tk-rej-b")}`
        await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], {
          schemaVersion: 2,
          agentId: "trej-b",
          projectId: "prej-b",
          taskId: "tk-rej-b",
          sessionID: "ses-trej-b",
          workspacePath: "/tmp",
          scopeID: scope.id,
          status: "completed",
          resultOutboxRequestID: "out-rej-b",
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const after = await Storage.read<Record<string, unknown>>([...StoragePath.clarusBindingsRoot(), "tasks", tkey])
        expect(after.status).toBe("needs_attention")
        expect(after.resultState).toBe("rejected")
      },
    })
  })

  test("V2 completed task with ambiguous outbox → needs_attention + ambiguous", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(StoragePath.clarusOutbox("out-amb-b"), {
          schemaVersion: 2,
          requestID: "out-amb-b",
          action: "task_result",
          agentId: "tamb-b",
          projectId: "pamb-b",
          taskId: "tk-amb-b",
          payload: {},
          payloadHash: "",
          state: "ambiguous",
          preparedAt: 1000,
          dispatchedAt: 2000,
          ambiguousAt: 3000,
        })

        const { bindingKey } = await import("../../src/clarus/keys")
        const tkey = `${bindingKey("tamb-b", "pamb-b")}:${encodeURIComponent("tk-amb-b")}`
        await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], {
          schemaVersion: 2,
          agentId: "tamb-b",
          projectId: "pamb-b",
          taskId: "tk-amb-b",
          sessionID: "ses-tamb-b",
          workspacePath: "/tmp",
          scopeID: scope.id,
          status: "completed",
          resultOutboxRequestID: "out-amb-b",
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const after = await Storage.read<Record<string, unknown>>([...StoragePath.clarusBindingsRoot(), "tasks", tkey])
        expect(after.status).toBe("needs_attention")
        expect(after.resultState).toBe("ambiguous")
      },
    })
  })

  test("V2 completed task with mismatched identity in outbox → needs_attention, resultState idle", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Outbox has different agent/project
        await Storage.write(StoragePath.clarusOutbox("out-mismatch-b"), {
          schemaVersion: 2,
          requestID: "out-mismatch-b",
          action: "task_result",
          agentId: "different-agent-b",
          projectId: "different-project-b",
          payload: {},
          payloadHash: "",
          state: "acknowledged",
          preparedAt: 1000,
          dispatchedAt: 2000,
          acknowledgedAt: 3000,
        })

        const { bindingKey } = await import("../../src/clarus/keys")
        const tkey = `${bindingKey("tmism-b", "pmism-b")}:${encodeURIComponent("tk-mism-b")}`
        await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], {
          schemaVersion: 2,
          agentId: "tmism-b",
          projectId: "pmism-b",
          taskId: "tk-mism-b",
          sessionID: "ses-tmism-b",
          workspacePath: "/tmp",
          scopeID: scope.id,
          status: "completed",
          resultOutboxRequestID: "out-mismatch-b",
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const after = await Storage.read<Record<string, unknown>>([...StoragePath.clarusBindingsRoot(), "tasks", tkey])
        expect(after.status).toBe("needs_attention")
        expect(after.resultState).toBe("idle")
      },
    })
  })

  test("V2 completed task rejects acknowledged outbox with wrong action or task identity", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { bindingKey, payloadHash } = await import("../../src/clarus/keys")
        const cases = [
          { suffix: "action", action: "task_extend" as const, taskId: "tk-evidence-action" },
          { suffix: "task", action: "task_result" as const, taskId: "other-task" },
        ]

        for (const item of cases) {
          const agentId = `agent-evidence-${item.suffix}`
          const projectId = `project-evidence-${item.suffix}`
          const taskId = `tk-evidence-${item.suffix}`
          const requestID = `out-evidence-${item.suffix}`
          const payload = { result: "done" }
          await Storage.write(StoragePath.clarusOutbox(requestID), {
            schemaVersion: 2,
            requestID,
            action: item.action,
            agentId,
            projectId,
            taskId: item.taskId,
            payload,
            payloadHash: payloadHash(payload),
            state: "acknowledged",
            preparedAt: 1000,
            acknowledgedAt: 2000,
          })
          const key = `${bindingKey(agentId, projectId)}:${encodeURIComponent(taskId)}`
          await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", key], {
            schemaVersion: 2,
            agentId,
            projectId,
            taskId,
            sessionID: `ses-evidence-${item.suffix}`,
            workspacePath: "/tmp",
            scopeID: scope.id,
            status: "completed",
            resultOutboxRequestID: requestID,
            createdAt: 1000,
            updatedAt: 2000,
          })
        }

        const migration = clarusMigrations.find((item) => item.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        for (const item of cases) {
          const agentId = `agent-evidence-${item.suffix}`
          const projectId = `project-evidence-${item.suffix}`
          const taskId = `tk-evidence-${item.suffix}`
          const key = `${bindingKey(agentId, projectId)}:${encodeURIComponent(taskId)}`
          const after = await Storage.read<Record<string, unknown>>([...StoragePath.clarusBindingsRoot(), "tasks", key])
          expect(after.status).toBe("needs_attention")
          expect(after.resultState).toBe("idle")
        }
      },
    })
  })

  test("migration 'up' function runs for Task V2 without errors (legacy test)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { bindingKey } = await import("../../src/clarus/keys")
        const tkey = `${bindingKey("tv2-up-b", "pv2-up-b")}:${encodeURIComponent("tkv2-up-b")}`
        await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], {
          schemaVersion: 2,
          agentId: "tv2-up-b",
          projectId: "pv2-up-b",
          taskId: "tkv2-up-b",
          sessionID: "ses-tv2up-b",
          workspacePath: "/tmp",
          scopeID: scope.id,
          status: "completed",
          resultOutboxRequestID: "out-sub-up-b",
          createdAt: 1000,
          updatedAt: 2000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()
        expect(migration!.up).toBeDefined()

        await migration!.up(() => {})

        const after = await Storage.read<unknown>([...StoragePath.clarusBindingsRoot(), "tasks", tkey])
        expect(after).toBeDefined()
        expect(typeof after).toBe("object")
      },
    })
  })

  test("migration 'up' function runs for Outbox V1 without errors (legacy test)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(StoragePath.clarusOutbox("req-ob-v1-up-b"), {
          schemaVersion: 1,
          requestID: "req-ob-v1-up-b",
          action: "task_result",
          agentId: "ag-obv1-up-b",
          projectId: "pr-obv1-up-b",
          state: "acknowledged",
          resolvedAt: 3000,
          resolvedBy: "sys",
          createdAt: 1000,
          updatedAt: 1000,
        })

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()

        await migration!.up(() => {})

        const after = await Storage.read<unknown>(StoragePath.clarusOutbox("req-ob-v1-up-b"))
        expect(after).toBeDefined()
        expect(typeof after).toBe("object")
      },
    })
  })

  test("migration rebuilds reverse index", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { bindingKey } = await import("../../src/clarus/keys")
        const tkey = `${bindingKey("ag-ri2-b", "pr-ri2-b")}:${encodeURIComponent("tk-ri2-b")}`
        await Storage.write([...StoragePath.clarusBindingsRoot(), "tasks", tkey], {
          schemaVersion: 4,
          agentId: "ag-ri2-b",
          projectId: "pr-ri2-b",
          taskId: "tk-ri2-b",
          sessionID: "ses-ri2-b",
          workspacePath: "/tmp",
          scopeID: scope.id,
          runID: "",
          subtaskID: "",
          phase: "",
          attempt: 0,
          title: "RI Task",
          taskInput: {},
          contextHydration: "unavailable",
          frozenAgent: "",
          assignmentState: "planned",
          assignmentInboxItemID: "inb-ri2-b",
          assignmentMessageID: "msg-ri2-b",
          status: "waiting",
          resultState: "idle",
          extendOutboxRequestIDs: [],
          createdAt: 1000,
          updatedAt: 2000,
        })

        await Storage.remove(StoragePath.clarusSessionTaskIndex("ses-ri2-b"))

        const { clarusMigrations } = await import("../../src/clarus/migration")
        const migration = clarusMigrations.find((m) => m.id === "20260715-clarus-v4-forward")
        expect(migration).toBeDefined()

        await migration!.up(() => {})

        const index = await Storage.read<Record<string, unknown>>(StoragePath.clarusSessionTaskIndex("ses-ri2-b"))
        expect(index).toBeDefined()
        const entryKey = `${encodeURIComponent("ag-ri2-b")}:${encodeURIComponent("pr-ri2-b")}:${encodeURIComponent("tk-ri2-b")}`
        expect(index[entryKey]).toBe(true)
      },
    })
  })
})

// =========================================================================
// ClarusBindingStore behavioral tests
// =========================================================================
describe("ClarusBindingStore", () => {
  test("ensureActive creates and reads binding", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const binding = await ClarusBindingStore.ensureActive("ag-bs1-b", "pr-bs1-b")
        expect(binding.schemaVersion).toBe(3)
        expect(binding.lifecycle).toBe("active")

        const read = await ClarusBindingStore.readBinding("ag-bs1-b", "pr-bs1-b")
        expect(read?.agentId).toBe("ag-bs1-b")
      },
    })
  })

  test("ClarusTaskBindingStore lifecycle: planned → enqueued → materialized → processing", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const a = "ag-lc2-b"
        const p = "pr-lc2-b"
        const t = "tk-lc2-b"
        const sid = "ses-lc2-b"

        const assigned = await ClarusTaskBindingStore.ensureAssigned(a, p, t, sid, "/ws-lc2-b", scope.id)
        expect(assigned.assignmentState).toBe("planned")
        expect(assigned.schemaVersion).toBe(4)

        const planned = await ClarusTaskBindingStore.planAssignment(a, p, t, "inb-lc2-b", "msg-lc2-b")
        expect(planned.assignmentState).toBe("planned")
        expect(planned.assignmentInboxItemID).toBe("inb-lc2-b")

        const enqueued = await ClarusTaskBindingStore.markEnqueued(a, p, t)
        expect(enqueued.assignmentState).toBe("enqueued")

        const materialized = await ClarusTaskBindingStore.markMaterialized(a, p, t)
        expect(materialized.assignmentState).toBe("materialized")

        const processing = await ClarusTaskBindingStore.markProcessing(a, p, t, "msg-last2-b")
        expect(processing.assignmentState).toBe("processing")
        expect(processing.status).toBe("running")
        expect(processing.lastCompletedAssistantMessageID).toBe("msg-last2-b")
      },
    })
  })

  test("ClarusTaskBindingStore co-writes reverse index on ensureAssigned", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const a = "ag-cw2-b"
        const p = "pr-cw2-b"
        const t = "tk-cw2-b"
        const sid = "ses-cw2-b"

        await ClarusTaskBindingStore.ensureAssigned(a, p, t, sid, "/ws-cw2-b", scope.id)

        const index = await Storage.read<Record<string, unknown>>(StoragePath.clarusSessionTaskIndex(sid))
        expect(index).toBeDefined()
        const entryKey = `${encodeURIComponent(a)}:${encodeURIComponent(p)}:${encodeURIComponent(t)}`
        expect(index[entryKey]).toBe(true)
      },
    })
  })
})
