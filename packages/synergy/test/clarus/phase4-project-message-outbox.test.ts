import { afterEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusOutbox, isTerminalOutboxState, validateOutboxIdentity } from "../../src/clarus/outbox"
import {
  ClarusOutboxRecordV2,
  ClarusOutboxAction,
  ClarusProjectMessagePayloadSchema,
  BoundedFileRefsSchema,
} from "../../src/clarus/schemas"
import { payloadHash } from "../../src/clarus/keys"

function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}

async function catchErr<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (e) {
    return e
  }
}

function isClarusOutboxCollision(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OUTBOX_COLLISION"
}

function isClarusOutboxTerminal(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OUTBOX_TERMINAL"
}

function pmPayload(content: string, extras?: Partial<Record<string, unknown>>) {
  return { content, ...extras }
}

// ============================================================================
// 1. Preallocation and exact replay
// ============================================================================
describe("project_message preallocation", () => {
  test("preallocate creates a project_message outbox record in prepared state", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_prep_001",
            action: "project_message",
            agentId: "ag-pm",
            projectId: "pr-pm",
            payload: pmPayload("Hello world"),
            connectionEpoch: "1",
            generation: 1,
          })

          expect(record.action).toBe("project_message")
          expect(record.agentId).toBe("ag-pm")
          expect(record.projectId).toBe("pr-pm")
          expect(record.taskId).toBeUndefined()
          expect(record.runId).toBeUndefined()
          expect(record.subtaskId).toBeUndefined()
          expect(record.state).toBe("prepared")
          expect(record.preparedAt).toBeGreaterThan(0)
          expect(record.connectionEpoch).toBe("1")
          expect(record.generation).toBe(1)
        })(),
    })
  })

  test("exact replay of preallocate returns existing record unchanged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const r1 = await ClarusOutbox.preallocate({
            requestID: "pm_replay",
            action: "project_message",
            agentId: "ag-rp",
            projectId: "pr-rp",
            payload: pmPayload("test replay"),
          })

          const r2 = await ClarusOutbox.preallocate({
            requestID: "pm_replay",
            action: "project_message",
            agentId: "ag-rp",
            projectId: "pr-rp",
            payload: pmPayload("test replay"),
          })

          expect(r2).toBeDefined()
          expect(r2.requestID).toBe(r1.requestID)
          expect(r2.state).toBe("prepared")
          expect(r2.preparedAt).toBe(r1.preparedAt)
        })(),
    })
  })

  test("userId survives round-trip in record identity", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_user_001",
            action: "project_message",
            agentId: "ag-pm",
            projectId: "pr-pm",
            userId: "user-abc",
            payload: pmPayload("message with user"),
          })

          expect(record.userId).toBe("user-abc")

          const fresh = await ClarusOutbox.get("pm_user_001")
          expect(fresh!.userId).toBe("user-abc")
        })(),
    })
  })

  test("no userId leaves field undefined in record", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_nouser",
            action: "project_message",
            agentId: "ag-pm",
            projectId: "pr-pm",
            payload: pmPayload("no user"),
          })

          expect(record.userId).toBeUndefined()
        })(),
    })
  })
})

// ============================================================================
// 2. Collision detection — one field at a time
// ============================================================================
describe("project_message collision detection", () => {
  test("collision on action mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_act",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            payload: pmPayload("content"),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_act",
              action: "task_result",
              agentId: "ag-c",
              projectId: "pr-c",
              payload: pmPayload("content"),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })

  test("collision on agentId mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_agent",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            payload: pmPayload("content"),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_agent",
              action: "project_message",
              agentId: "ag-wrong",
              projectId: "pr-c",
              payload: pmPayload("content"),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })

  test("collision on projectId mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_proj",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            payload: pmPayload("content"),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_proj",
              action: "project_message",
              agentId: "ag-c",
              projectId: "pr-wrong",
              payload: pmPayload("content"),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })

  test("collision on content mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_cont",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            payload: pmPayload("original"),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_cont",
              action: "project_message",
              agentId: "ag-c",
              projectId: "pr-c",
              payload: pmPayload("different"),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })

  test("collision on messageType mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_mtype",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            payload: pmPayload("content", { messageType: "text" }),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_mtype",
              action: "project_message",
              agentId: "ag-c",
              projectId: "pr-c",
              payload: pmPayload("content", { messageType: "image" }),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })

  test("collision on fileRefs mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_frefs",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            payload: pmPayload("content", { fileRefs: [{ name: "a.pdf" }] }),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_frefs",
              action: "project_message",
              agentId: "ag-c",
              projectId: "pr-c",
              payload: pmPayload("content", { fileRefs: [{ name: "b.pdf" }] }),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })

  test("collision on userId mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_user",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            userId: "user-a",
            payload: pmPayload("content"),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_user",
              action: "project_message",
              agentId: "ag-c",
              projectId: "pr-c",
              userId: "user-b",
              payload: pmPayload("content"),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })

  test("collision when original has no userId but replay provides one", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID: "pm_coll_nouser",
            action: "project_message",
            agentId: "ag-c",
            projectId: "pr-c",
            payload: pmPayload("content"),
          })

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID: "pm_coll_nouser",
              action: "project_message",
              agentId: "ag-c",
              projectId: "pr-c",
              userId: "new-user",
              payload: pmPayload("content"),
            }),
          )
          expect(isClarusOutboxCollision(err)).toBe(true)
        })(),
    })
  })
})

// ============================================================================
// 3. Canonical ordering
// ============================================================================
describe("project_message canonical ordering", () => {
  test("payload hash is identical regardless of object key order", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          // Key order: content, messageType
          const r1 = await ClarusOutbox.preallocate({
            requestID: "pm_canon",
            action: "project_message",
            agentId: "ag-co",
            projectId: "pr-co",
            payload: { content: "hello", messageType: "text" },
          })

          const r2 = await ClarusOutbox.preallocate({
            requestID: "pm_canon",
            action: "project_message",
            agentId: "ag-co",
            projectId: "pr-co",
            // Key order: messageType, content (reversed)
            payload: { messageType: "text", content: "hello" },
          })

          expect(r1.payloadHash).toBe(r2.payloadHash)
          expect(r2.state).toBe("prepared")
        })(),
    })
  })

  test("payload hash differs for different content with same canonical structure", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const r1 = await ClarusOutbox.preallocate({
            requestID: "pm_ph_a",
            action: "project_message",
            agentId: "ag-ph",
            projectId: "pr-ph",
            payload: pmPayload("msg-a"),
          })
          const r2 = await ClarusOutbox.preallocate({
            requestID: "pm_ph_b",
            action: "project_message",
            agentId: "ag-ph",
            projectId: "pr-ph",
            payload: pmPayload("msg-b"),
          })
          expect(r1.payloadHash).not.toBe(r2.payloadHash)
        })(),
    })
  })
})

// ============================================================================
// 4. Transitions — prepared → dispatched → acknowledged/rejected/ambiguous
// ============================================================================
describe("project_message state transitions", () => {
  test("prepared → dispatched → acknowledged with acknowledgedPayload", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_trans_ack"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tr",
            projectId: "pr-tr",
            payload: pmPayload("transition test"),
          })

          const d = await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "2", generation: 3 })
          expect(d.state).toBe("dispatched")
          expect(d.dispatchedAt).toBeGreaterThan(0)

          const ack = await ClarusOutbox.markAcknowledged(requestID, { messageId: "msg-server-1" })
          expect(ack.state).toBe("acknowledged")
          expect(ack.acknowledgedAt).toBeGreaterThan(0)
          expect(ack.acknowledgedPayload).toEqual({ messageId: "msg-server-1" })
        })(),
    })
  })

  test("prepared → dispatched → rejected", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_trans_rej"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tr",
            projectId: "pr-tr",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markDispatched(requestID)
          const r = await ClarusOutbox.markRejected(requestID, "REJ", "bad message")
          expect(r.state).toBe("rejected")
          expect(r.errorCode).toBe("REJ")
        })(),
    })
  })

  test("prepared → dispatched → ambiguous", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_trans_amb"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tr",
            projectId: "pr-tr",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markDispatched(requestID)
          const r = await ClarusOutbox.markAmbiguous(requestID, "AMB", "timeout")
          expect(r.state).toBe("ambiguous")
          expect(r.errorCode).toBe("AMB")
        })(),
    })
  })

  test("prepared — skip dispatched → acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_skip_ack"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tr",
            projectId: "pr-tr",
            payload: pmPayload("test"),
          })
          // markAcknowledged from prepared should still work (dispatchedAt won't be set)
          const ack = await ClarusOutbox.markAcknowledged(requestID, { messageId: "direct" })
          expect(ack.state).toBe("acknowledged")
          expect(ack.acknowledgedPayload).toEqual({ messageId: "direct" })
          expect(ack.dispatchedAt).toBeUndefined()
        })(),
    })
  })

  test("acknowledged replay without acknowledgedPayload is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_ack_idem"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tr",
            projectId: "pr-tr",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markAcknowledged(requestID, { messageId: "first" })
          const replay = await ClarusOutbox.markAcknowledged(requestID)
          expect(replay.state).toBe("acknowledged")
          expect(replay.acknowledgedPayload).toEqual({ messageId: "first" })
        })(),
    })
  })
})

// ============================================================================
// 5. Cross-terminal rejection
// ============================================================================
describe("project_message terminal immutability", () => {
  test("rejected cannot transition to acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_term_rej"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tm",
            projectId: "pr-tm",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markRejected(requestID, "E1", "fail")

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(isClarusOutboxTerminal(err)).toBe(true)

          const record = await ClarusOutbox.get(requestID)
          expect(record!.state).toBe("rejected")
        })(),
    })
  })

  test("ambiguous cannot transition to acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_term_amb"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tm",
            projectId: "pr-tm",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markAmbiguous(requestID, "AMB", "timeout")

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("acknowledged cannot transition to rejected", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_term_ack"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tm",
            projectId: "pr-tm",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markAcknowledged(requestID)

          const err = await catchErr(ClarusOutbox.markRejected(requestID, "E2"))
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("local_only cannot transition to acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_term_lo"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tm",
            projectId: "pr-tm",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markLocalOnly(requestID)

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("terminal state rejects preallocate", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_term_pre"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tm",
            projectId: "pr-tm",
            payload: pmPayload("test"),
          })
          await ClarusOutbox.markAcknowledged(requestID)

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID,
              action: "project_message",
              agentId: "ag-tm",
              projectId: "pr-tm",
              payload: pmPayload("test"),
            }),
          )
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("ambiguous idempotent replay returns same state", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_amb_idem"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-tm",
            projectId: "pr-tm",
            payload: pmPayload("test"),
          })
          const r1 = await ClarusOutbox.markAmbiguous(requestID, "AMB", "timeout")
          const r2 = await ClarusOutbox.markAmbiguous(requestID, "AMB", "timeout")
          expect(r2.state).toBe("ambiguous")
          expect(r2.errorCode).toBe(r1.errorCode)
          expect(r2.ambiguousAt).toBe(r1.ambiguousAt)
        })(),
    })
  })
})

// ============================================================================
// 6. Multibyte bounds
// ============================================================================
describe("project_message multibyte content", () => {
  test("unic內容ode message payload is stored and read back intact", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const content = "你好世界 🌍 — émoji test"
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_unicode",
            action: "project_message",
            agentId: "ag-mb",
            projectId: "pr-mb",
            payload: pmPayload(content),
          })
          expect(record.payload.content).toBe(content)

          const fresh = await ClarusOutbox.get("pm_unicode")
          expect(fresh!.payload.content).toBe(content)
        })(),
    })
  })

  test("multibyte payload hash is consistent on replay", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const payload = { content: "中文消息 🎉" }
          const r1 = await ClarusOutbox.preallocate({
            requestID: "pm_mb_hash",
            action: "project_message",
            agentId: "ag-mb",
            projectId: "pr-mb",
            payload,
          })
          const r2 = await ClarusOutbox.preallocate({
            requestID: "pm_mb_hash",
            action: "project_message",
            agentId: "ag-mb",
            projectId: "pr-mb",
            payload,
          })
          expect(r1.payloadHash).toBe(r2.payloadHash)
        })(),
    })
  })
})

// ============================================================================
// 7. Restart readback
// ============================================================================
describe("project_message restart readback", () => {
  test("record persisted in one scope session survives reading in another", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const requestID = "pm_persist"

    // Write
    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-persist",
            projectId: "pr-persist",
            userId: "user-p",
            payload: pmPayload("persisted message"),
          })
          await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "4", generation: 7 })
          await ClarusOutbox.markAcknowledged(requestID, { messageId: "srv-msg-1", projectSlug: "test-proj" })
        })(),
    })

    // Read back in a fresh scope context
    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.get(requestID)
          expect(record).toBeDefined()
          expect(record!.action).toBe("project_message")
          expect(record!.agentId).toBe("ag-persist")
          expect(record!.projectId).toBe("pr-persist")
          expect(record!.userId).toBe("user-p")
          expect(record!.state).toBe("acknowledged")
          expect(record!.acknowledgedPayload).toEqual({ messageId: "srv-msg-1", projectSlug: "test-proj" })
          expect(record!.payloadHash).toBe(payloadHash(pmPayload("persisted message")))
          expect(record!.preparedAt).toBeGreaterThan(0)
          expect(record!.dispatchedAt).toBeGreaterThan(0)
          expect(record!.acknowledgedAt).toBeGreaterThan(0)
        })(),
    })
  })

  test("fresh restart can parse existing task_result records unchanged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const requestID = "pm_regress_tr"

    // Write a task_result record
    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-reg",
            projectId: "pr-reg",
            taskId: "tk-reg",
            runId: "run-reg",
            subtaskId: "sub-reg",
            payload: { status: "done" },
          })
          await ClarusOutbox.markDispatched(requestID)
          await ClarusOutbox.markAcknowledged(requestID, { serverResult: 42 })
        })(),
    })

    // Read back and verify task_result fields are intact
    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.get(requestID)
          expect(record!.action).toBe("task_result")
          expect(record!.taskId).toBe("tk-reg")
          expect(record!.runId).toBe("run-reg")
          expect(record!.subtaskId).toBe("sub-reg")
          expect(record!.payload).toEqual({ status: "done" })
          expect(record!.state).toBe("acknowledged")
          expect(record!.acknowledgedPayload).toEqual({ serverResult: 42 })
          expect(record!.userId).toBeUndefined()
        })(),
    })
  })

  test("task_result without userId parses cleanly (regression)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const requestID = "pm_regress_nouser"

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-reg2",
            projectId: "pr-reg2",
            taskId: "tk-reg2",
            payload: { goal: "test" },
          })
          const record = await ClarusOutbox.get(requestID)
          const parsed = ClarusOutboxRecordV2.safeParse(record)
          expect(parsed.success).toBe(true)
          if (parsed.success) {
            expect(parsed.data.userId).toBeUndefined()
            expect(parsed.data.acknowledgedPayload).toBeUndefined()
          }
        })(),
    })
  })
})

// ============================================================================
// 8. Payload schema validation
// ============================================================================
describe("ClarusProjectMessagePayloadSchema validation", () => {
  test("accepts minimal payload with content only", () => {
    const result = ClarusProjectMessagePayloadSchema.safeParse({ content: "hello" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.content).toBe("hello")
      expect(result.data.messageType).toBeUndefined()
      expect(result.data.fileRefs).toBeUndefined()
    }
  })

  test("accepts payload with content and messageType", () => {
    const result = ClarusProjectMessagePayloadSchema.safeParse({ content: "hello", messageType: "text" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.messageType).toBe("text")
    }
  })

  test("accepts payload with content and fileRefs", () => {
    const result = ClarusProjectMessagePayloadSchema.safeParse({
      content: "hello",
      fileRefs: [{ name: "doc.pdf", url: "https://example.com/doc.pdf" }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.fileRefs).toHaveLength(1)
    }
  })

  test("accepts payload with all fields", () => {
    const result = ClarusProjectMessagePayloadSchema.safeParse({
      content: "full message",
      messageType: "rich_text",
      fileRefs: [{ name: "img.png" }],
    })
    expect(result.success).toBe(true)
  })

  test("rejects payload missing content", () => {
    const result = ClarusProjectMessagePayloadSchema.safeParse({ messageType: "text" })
    expect(result.success).toBe(false)
  })

  test("rejects payload with extra unknown fields", () => {
    const result = ClarusProjectMessagePayloadSchema.safeParse({
      content: "hello",
      unknownField: "should fail",
    })
    expect(result.success).toBe(false)
  })

  test("rejects payload with oversized fileRefs", () => {
    const refs = Array.from({ length: 51 }, (_, i) => ({ name: `file_${i}` }))
    const result = ClarusProjectMessagePayloadSchema.safeParse({ content: "hello", fileRefs: refs })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// 9. FileRefs with real bounded validation through outbox preallocate
// ============================================================================
describe("project_message fileRefs bounded validation", () => {
  test("fileRefs with cycle are rejected at schema level", () => {
    const a: Record<string, unknown> = { name: "a" }
    const b: Record<string, unknown> = { name: "b", ref: a }
    a.ref = b
    const result = ClarusProjectMessagePayloadSchema.safeParse({ content: "x", fileRefs: [a] })
    expect(result.success).toBe(false)
  })

  test("fileRefs with legal items survive outbox round-trip", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const fileRefs = [
      { name: "report.pdf", url: "https://example.com/report.pdf" },
      { name: "screenshot.png", url: "https://example.com/screenshot.png" },
    ]

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_frefs_ok",
            action: "project_message",
            agentId: "ag-fr",
            projectId: "pr-fr",
            payload: pmPayload("with refs", { fileRefs }),
          })

          const fresh = await ClarusOutbox.get("pm_frefs_ok")
          expect(fresh!.payload.fileRefs).toEqual(fileRefs)
          expect(fresh!.payload.content).toBe("with refs")
        })(),
    })
  })
})

// ============================================================================
// 10. validateOutboxIdentity integration
// ============================================================================
describe("validateOutboxIdentity with project_message", () => {
  test("validateOutboxIdentity passes on exact match", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_voi",
            action: "project_message",
            agentId: "ag-voi",
            projectId: "pr-voi",
            userId: "user-voi",
            payload: pmPayload("valid"),
          })

          expect(() =>
            validateOutboxIdentity(record, {
              requestID: "pm_voi",
              action: "project_message",
              agentId: "ag-voi",
              projectId: "pr-voi",
              userId: "user-voi",
              payload: pmPayload("valid"),
            }),
          ).not.toThrow()
        })(),
    })
  })

  test("validateOutboxIdentity throws on userId mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_voi_bad",
            action: "project_message",
            agentId: "ag-voi",
            projectId: "pr-voi",
            userId: "user-a",
            payload: pmPayload("test"),
          })

          expect(() =>
            validateOutboxIdentity(record, {
              requestID: "pm_voi_bad",
              action: "project_message",
              agentId: "ag-voi",
              projectId: "pr-voi",
              userId: "user-b",
              payload: pmPayload("test"),
            }),
          ).toThrow()
        })(),
    })
  })
})

// ============================================================================
// 11. No taskId requirement
// ============================================================================
describe("project_message does not require taskId", () => {
  test("preallocate without taskId succeeds", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const record = await ClarusOutbox.preallocate({
            requestID: "pm_notask",
            action: "project_message",
            agentId: "ag-nt",
            projectId: "pr-nt",
            payload: pmPayload("no task"),
          })

          expect(record.taskId).toBeUndefined()
        })(),
    })
  })

  test("preallocate with taskId still works (extra field, not identity mismatch)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const r1 = await ClarusOutbox.preallocate({
            requestID: "pm_withtask",
            action: "project_message",
            agentId: "ag-wt",
            projectId: "pr-wt",
            taskId: "tk-something",
            payload: pmPayload("with task"),
          })

          // Exact replay with same taskId succeeds
          const r2 = await ClarusOutbox.preallocate({
            requestID: "pm_withtask",
            action: "project_message",
            agentId: "ag-wt",
            projectId: "pr-wt",
            taskId: "tk-something",
            payload: pmPayload("with task"),
          })
          expect(r2.state).toBe("prepared")
        })(),
    })
  })
})

// ============================================================================
// 12. acknowledgedPayload idempotent replay
// ============================================================================
describe("acknowledgedPayload idempotent replay for project_message", () => {
  test("acknowledged with payload then replayed without payload preserves original", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "pm_ackpl_1"
          await ClarusOutbox.preallocate({
            requestID,
            action: "project_message",
            agentId: "ag-ap",
            projectId: "pr-ap",
            payload: pmPayload("test"),
          })

          const ack1 = await ClarusOutbox.markAcknowledged(requestID, { messageId: "m1", projectSlug: "slug" })
          expect(ack1.acknowledgedPayload).toEqual({ messageId: "m1", projectSlug: "slug" })

          // Replay without acknowledgedPayload — should still return original
          const ack2 = await ClarusOutbox.markAcknowledged(requestID)
          expect(ack2.acknowledgedPayload).toEqual({ messageId: "m1", projectSlug: "slug" })
        })(),
    })
  })
})
