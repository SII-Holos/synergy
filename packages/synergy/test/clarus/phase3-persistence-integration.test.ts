import { describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusOutbox, isTerminalOutboxState } from "../../src/clarus/outbox"
import { ClarusTaskBindingStore } from "../../src/clarus/binding"
import {
  ClarusTaskBindingV4Schema,
  ClarusOutboxRecordV2,
  ClarusOutboxStateV2,
  type ClarusTaskBindingV4,
} from "../../src/clarus/schemas"
import { payloadHash } from "../../src/clarus/keys"
import { clarusMigrations } from "../../src/clarus/migration"

function isClarusOutboxTerminal(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OUTBOX_TERMINAL"
}

function isClarusOwnershipResolved(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OWNERSHIP_RESOLVED"
}

function isClarusOwnershipConflict(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OWNERSHIP_CONFLICT"
}

function isClarusOwnershipNoClaim(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "CLARUS_OWNERSHIP_NO_CLAIM"
}

function using(fn: () => Promise<void>): () => Promise<void> {
  return fn
}

/** Catch an async rejection and return the error (or null on success). */
async function catchErr<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (e) {
    return e
  }
}

// =========================================================================
// 1. Safe bounded outbox request keys
// =========================================================================
describe("Outbox safe request keys", () => {
  test("outbox uses safe bounded request key (StoragePath.clarusOutboxRequestKey)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_safe_001"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-safe",
            projectId: "pr-safe",
            taskId: "tk-safe",
            payload: { status: "done" },
          })

          const safePath = StoragePath.clarusOutboxRequestKey(requestID)
          const read = await Storage.read<unknown>(safePath)
          expect(read).toBeDefined()

          const parsed = ClarusOutboxRecordV2.safeParse(read)
          expect(parsed.success).toBe(true)
          if (parsed.success) {
            expect(parsed.data.requestID).toBe(requestID)
            expect(parsed.data.state).toBe("prepared")
          }

          const got = await ClarusOutbox.get(requestID)
          expect(got).toBeDefined()
          expect(got!.requestID).toBe(requestID)
          expect(got!.state).toBe("prepared")
        })(),
    })
  })

  test("outbox requestID with invalid characters is rejected by safe key", () => {
    expect(() => StoragePath.clarusOutboxRequestKey("bad/request")).toThrow("path separator")
    expect(() => StoragePath.clarusOutboxRequestKey("")).toThrow("empty")
    expect(() => StoragePath.clarusOutboxRequestKey("\0null")).toThrow("NUL")
    expect(() => StoragePath.clarusOutboxRequestKey("a".repeat(257))).toThrow("maximum length")
  })

  test("outbox preallocate with safe key survives round-trip through markDispatched → markAcknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_lifecycle_1"
          const r1 = await ClarusOutbox.preallocate({
            requestID,
            action: "project_subscribe",
            agentId: "ag-life",
            projectId: "pr-life",
            payload: { project: "test" },
          })
          expect(r1.state).toBe("prepared")

          const r2 = await ClarusOutbox.markDispatched(requestID, { connectionEpoch: "ep1", generation: 1 })
          expect(r2.state).toBe("dispatched")
          expect(r2.dispatchedAt).toBeGreaterThan(0)
          expect(r2.connectionEpoch).toBe("ep1")

          const r3 = await ClarusOutbox.markAcknowledged(requestID)
          expect(r3.state).toBe("acknowledged")
          expect(r3.acknowledgedAt).toBeGreaterThan(0)
        })(),
    })
  })
})

// =========================================================================
// 2. Terminal outbox state enforcement
// =========================================================================
describe("Outbox terminal state enforcement", () => {
  test("TERMINAL_STATES includes acknowledged, rejected, ambiguous, local_only", () => {
    expect(isTerminalOutboxState("acknowledged")).toBe(true)
    expect(isTerminalOutboxState("rejected")).toBe(true)
    expect(isTerminalOutboxState("ambiguous")).toBe(true)
    expect(isTerminalOutboxState("local_only")).toBe(true)
    expect(isTerminalOutboxState("prepared")).toBe(false)
    expect(isTerminalOutboxState("dispatched")).toBe(false)
  })

  test("acknowledged rejects non-exact replay (cannot transition from rejected to acknowledged)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_ack_reject"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markRejected(requestID, "E001", "rejected")

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("ambiguous exact replay with same error details is idempotent, different details rejects", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_amb_diff"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markAmbiguous(requestID, "AMB001", "ambiguous result")

          // Exact replay (same error details) is idempotent
          const r = await ClarusOutbox.markAmbiguous(requestID, "AMB001", "ambiguous result")
          expect(r.state).toBe("ambiguous")

          // Different error code rejects
          const err = await catchErr(ClarusOutbox.markAmbiguous(requestID, "AMB002", "ambiguous result"))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("rejected exact replay with same error details is idempotent, different details rejects", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_rej_exact"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markRejected(requestID, "ERR_001", "rejected permanently")

          const r = await ClarusOutbox.markRejected(requestID, "ERR_001", "rejected permanently")
          expect(r.state).toBe("rejected")
          expect(r.errorCode).toBe("ERR_001")

          const err = await catchErr(ClarusOutbox.markRejected(requestID, "ERR_002", "different"))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("local_only is terminal and irreversible", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_local_only"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })

          const r1 = await ClarusOutbox.markLocalOnly(requestID)
          expect(r1.state).toBe("local_only")
          expect(r1.localOnlyAt).toBeGreaterThan(0)

          // local_only is idempotent
          const r2 = await ClarusOutbox.markLocalOnly(requestID)
          expect(r2.state).toBe("local_only")

          // Cannot transition from local_only to anything else
          const errAck = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(isClarusOutboxTerminal(errAck)).toBe(true)

          const errRej = await catchErr(ClarusOutbox.markRejected(requestID))
          expect(isClarusOutboxTerminal(errRej)).toBe(true)

          const errAmb = await catchErr(ClarusOutbox.markAmbiguous(requestID))
          expect(isClarusOutboxTerminal(errAmb)).toBe(true)

          // markDispatched on terminal is no-op
          const r3 = await ClarusOutbox.markDispatched(requestID)
          expect(r3.state).toBe("local_only")
        })(),
    })
  })

  test("preallocate over terminal record throws", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_pre_term"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markAcknowledged(requestID)

          const err = await catchErr(
            ClarusOutbox.preallocate({
              requestID,
              action: "task_result",
              agentId: "ag-1",
              projectId: "pr-1",
              payload: {},
            }),
          )
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("markAcknowledged rejects transition from rejected", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_ack_rej"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markRejected(requestID)

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("markAcknowledged rejects transition from ambiguous", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_ack_amb"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markAmbiguous(requestID)

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("markAcknowledged is idempotent on already-acknowledged", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_ack_idem"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markAcknowledged(requestID)

          const r = await ClarusOutbox.markAcknowledged(requestID)
          expect(r.state).toBe("acknowledged")
        })(),
    })
  })

  test("markAcknowledged rejects transition from local_only", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_ack_lo"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markLocalOnly(requestID)

          const err = await catchErr(ClarusOutbox.markAcknowledged(requestID))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOutboxTerminal(err)).toBe(true)
        })(),
    })
  })

  test("markDispatched on terminal is no-op", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_disp_term"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-1",
            projectId: "pr-1",
            payload: {},
          })
          await ClarusOutbox.markAcknowledged(requestID)

          const r = await ClarusOutbox.markDispatched(requestID)
          expect(r.state).toBe("acknowledged")
        })(),
    })
  })
})

// =========================================================================
// 3. Canonical materializedAt in TaskBinding V4
// =========================================================================
describe("Canonical materializedAt", () => {
  test("materializeAssignment sets materializedAt directly on the binding (no sidecar)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-mat"
          const projectId = "pr-mat"
          const taskId = "tk-mat"
          const sessionID = "ses-mat"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, sessionID, "/tmp/ws", scope.id)

          const result = await ClarusTaskBindingStore.materializeAssignment({
            agentId,
            projectId,
            taskId,
            runID: "run-1",
            phase: "exec",
            subtaskID: "sub-1",
            attempt: 1,
            frozenAgent: "ag-frozen",
            title: "Test Task",
            taskInput: { goal: "test" },
            contextHydration: "complete",
          })

          expect(result.materializedAt).toBeGreaterThan(0)
          expect(result.assignmentState).toBe("materialized")
          expect(result.status).toBe("running")

          const binding = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
          expect(binding).toBeDefined()
          expect(binding!.materializedAt).toBe(result.materializedAt)
          expect(binding!.assignmentState).toBe("materialized")

          // Verify no sidecar marker exists
          const sidecarPath = [
            ...StoragePath.clarusBindingsRoot(),
            "tasks",
            `${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`,
            "_materialized",
          ]
          const sidecar = await Storage.read<unknown>(sidecarPath).catch(() => undefined)
          expect(sidecar).toBeUndefined()
        })(),
    })
  })

  test("V4 schema validates with optional materializedAt", () => {
    const result = ClarusTaskBindingV4Schema.safeParse({
      schemaVersion: 4,
      agentId: "agent-1",
      projectId: "project-1",
      taskId: "task-1",
      sessionID: "ses-1",
      workspacePath: "/tmp",
      scopeID: "scope-1",
      runID: "",
      subtaskID: "",
      phase: "",
      attempt: 0,
      title: "Test",
      taskInput: {},
      contextHydration: "unavailable",
      frozenAgent: "",
      assignmentState: "planned",
      assignmentInboxItemID: "inb-1",
      assignmentMessageID: "msg-1",
      status: "waiting",
      resultState: "idle",
      extendOutboxRequestIDs: [],
      createdAt: 0,
      updatedAt: 0,
      materializedAt: 1234567890,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.materializedAt).toBe(1234567890)
    }
  })
})

// =========================================================================
// 4. Task session ownership claim
// =========================================================================
describe("Task session ownership claim", () => {
  test("acquireOwnership sets claim on binding", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-own"
          const projectId = "pr-own"
          const taskId = "tk-own"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-own", "/tmp/ws", scope.id)

          const binding = await ClarusTaskBindingStore.acquireOwnership({
            agentId,
            projectId,
            taskId,
            claimedByScopeID: scope.id,
          })

          expect(binding.taskSessionOwnershipClaim).toBeDefined()
          expect(binding.taskSessionOwnershipClaim!.claimedByScopeID).toBe(scope.id)
          expect(binding.taskSessionOwnershipClaim!.claimedAt).toBeGreaterThan(0)
          expect(binding.taskSessionOwnershipClaim!.resolvedAt).toBeUndefined()
        })(),
    })
  })

  test("acquireOwnership is idempotent for same scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-own2"
          const projectId = "pr-own2"
          const taskId = "tk-own2"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-own2", "/tmp/ws", scope.id)

          const b1 = await ClarusTaskBindingStore.acquireOwnership({
            agentId,
            projectId,
            taskId,
            claimedByScopeID: scope.id,
          })
          const b2 = await ClarusTaskBindingStore.acquireOwnership({
            agentId,
            projectId,
            taskId,
            claimedByScopeID: scope.id,
          })

          expect(b2.taskSessionOwnershipClaim!.claimedAt).toBe(b1.taskSessionOwnershipClaim!.claimedAt)
        })(),
    })
  })

  test("acquireOwnership with different scope throws CLARUS_OWNERSHIP_CONFLICT", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-own3"
          const projectId = "pr-own3"
          const taskId = "tk-own3"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-own3", "/tmp/ws", scope.id)
          await ClarusTaskBindingStore.acquireOwnership({ agentId, projectId, taskId, claimedByScopeID: scope.id })

          const err = await catchErr(
            ClarusTaskBindingStore.acquireOwnership({
              agentId,
              projectId,
              taskId,
              claimedByScopeID: "other-scope-id",
            }),
          )
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOwnershipConflict(err)).toBe(true)
        })(),
    })
  })

  test("acquireOwnership after resolve throws CLARUS_OWNERSHIP_RESOLVED", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-own4"
          const projectId = "pr-own4"
          const taskId = "tk-own4"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-own4", "/tmp/ws", scope.id)
          await ClarusTaskBindingStore.acquireOwnership({ agentId, projectId, taskId, claimedByScopeID: scope.id })
          await ClarusTaskBindingStore.resolveOwnership({ agentId, projectId, taskId })

          const err = await catchErr(
            ClarusTaskBindingStore.acquireOwnership({ agentId, projectId, taskId, claimedByScopeID: scope.id }),
          )
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOwnershipResolved(err)).toBe(true)
        })(),
    })
  })

  test("resolveOwnership sets resolvedAt", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-own5"
          const projectId = "pr-own5"
          const taskId = "tk-own5"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-own5", "/tmp/ws", scope.id)
          await ClarusTaskBindingStore.acquireOwnership({ agentId, projectId, taskId, claimedByScopeID: scope.id })

          const resolved = await ClarusTaskBindingStore.resolveOwnership({ agentId, projectId, taskId })
          expect(resolved.taskSessionOwnershipClaim!.resolvedAt).toBeGreaterThan(0)

          const r2 = await ClarusTaskBindingStore.resolveOwnership({ agentId, projectId, taskId })
          expect(r2.taskSessionOwnershipClaim!.resolvedAt).toBe(resolved.taskSessionOwnershipClaim!.resolvedAt)
        })(),
    })
  })

  test("resolveOwnership throws CLARUS_OWNERSHIP_NO_CLAIM when no claim", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-own6"
          const projectId = "pr-own6"
          const taskId = "tk-own6"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-own6", "/tmp/ws", scope.id)

          const err = await catchErr(ClarusTaskBindingStore.resolveOwnership({ agentId, projectId, taskId }))
          expect(err).toBeInstanceOf(Error)
          expect(isClarusOwnershipNoClaim(err)).toBe(true)
        })(),
    })
  })

  test("recoverOwnership returns binding for unresolved claim by same scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-rec"
          const projectId = "pr-rec"
          const taskId = "tk-rec"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-rec", "/tmp/ws", scope.id)
          await ClarusTaskBindingStore.acquireOwnership({ agentId, projectId, taskId, claimedByScopeID: scope.id })

          const recovered = await ClarusTaskBindingStore.recoverOwnership({
            agentId,
            projectId,
            taskId,
            claimedByScopeID: scope.id,
          })
          expect(recovered).toBeDefined()
          expect(recovered!.taskSessionOwnershipClaim!.claimedByScopeID).toBe(scope.id)

          const notRecoverable = await ClarusTaskBindingStore.recoverOwnership({
            agentId,
            projectId,
            taskId,
            claimedByScopeID: "other-scope",
          })
          expect(notRecoverable).toBeUndefined()
        })(),
    })
  })

  test("recoverOwnership returns undefined for resolved claim", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-rec2"
          const projectId = "pr-rec2"
          const taskId = "tk-rec2"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-rec2", "/tmp/ws", scope.id)
          await ClarusTaskBindingStore.acquireOwnership({ agentId, projectId, taskId, claimedByScopeID: scope.id })
          await ClarusTaskBindingStore.resolveOwnership({ agentId, projectId, taskId })

          const recovered = await ClarusTaskBindingStore.recoverOwnership({
            agentId,
            projectId,
            taskId,
            claimedByScopeID: scope.id,
          })
          expect(recovered).toBeUndefined()
        })(),
    })
  })

  test("recoverOwnership returns undefined when no claim exists", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-rec3"
          const projectId = "pr-rec3"
          const taskId = "tk-rec3"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, "ses-rec3", "/tmp/ws", scope.id)

          const recovered = await ClarusTaskBindingStore.recoverOwnership({
            agentId,
            projectId,
            taskId,
            claimedByScopeID: scope.id,
          })
          expect(recovered).toBeUndefined()
        })(),
    })
  })
})

// =========================================================================
// 5. Outbox local_only state
// =========================================================================
describe("Outbox local_only state", () => {
  test("local_only outbox record has localOnlyAt timestamp", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const requestID = "req_lo_ts"
          await ClarusOutbox.preallocate({
            requestID,
            action: "task_result",
            agentId: "ag-lo",
            projectId: "pr-lo",
            payload: {},
          })

          const r2 = await ClarusOutbox.markLocalOnly(requestID)
          expect(r2.localOnlyAt).toBeGreaterThan(0)

          const got = await ClarusOutbox.get(requestID)
          expect(got).toBeDefined()
          expect(got!.state).toBe("local_only")
          expect(got!.localOnlyAt).toBe(r2.localOnlyAt)
        })(),
    })
  })
})

// =========================================================================
// 6. Migration idempotence: materializedAt sidecar migration
// =========================================================================
describe("Migration — materializedAt sidecar migration", () => {
  test("migration idempotent on fresh install (no-op, zero failures)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          for (const m of clarusMigrations) {
            await m.up(() => {})
          }
        })(),
    })
  })

  test("migrates _materialized sidecar into canonical V4 binding", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-migside"
          const projectId = "pr-migside"
          const taskId = "tk-migside"
          const sessionID = "ses-migside"

          // Seed V4 binding to legacy flat path (simulates pre-sharding data)
          const binding: ClarusTaskBindingV4 = {
            schemaVersion: 4,
            agentId,
            projectId,
            taskId,
            sessionID,
            workspacePath: "/tmp/ws",
            scopeID: scope.id,
            runID: "",
            subtaskID: "",
            phase: "",
            attempt: 0,
            title: taskId,
            taskInput: {},
            contextHydration: "unavailable",
            frozenAgent: "",
            assignmentState: "planned",
            assignmentInboxItemID: "",
            assignmentMessageID: "",
            status: "waiting",
            resultState: "idle",
            extendOutboxRequestIDs: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          const taskKey = `${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`
          const taskFlatPath = [...StoragePath.clarusBindingsRoot(), "tasks", taskKey]
          await Storage.write(taskFlatPath, binding)

          const sidecarPath = [...taskFlatPath, "_materialized"]
          await Storage.write(sidecarPath, { materializedAt: 1700000000000 })

          const sidecarBefore = await Storage.read<{ materializedAt: number }>(sidecarPath).catch(() => undefined)
          expect(sidecarBefore).toBeDefined()
          expect(sidecarBefore!.materializedAt).toBe(1700000000000)

          for (const m of clarusMigrations) {
            await m.up(() => {})
          }

          const sidecarAfter = await Storage.read<unknown>(sidecarPath).catch(() => undefined)
          expect(sidecarAfter).toBeUndefined()

          const bindingAfter = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
          expect(bindingAfter).toBeDefined()
          expect(bindingAfter!.materializedAt).toBe(1700000000000)
        })(),
    })
  })

  test("migration with existing V4 and no sidecar is safe no-op", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-nosidecar"
          const projectId = "pr-nosidecar"
          const taskId = "tk-nosidecar"
          const sessionID = "ses-nosidecar"

          await ClarusTaskBindingStore.ensureAssigned(agentId, projectId, taskId, sessionID, "/tmp/ws", scope.id)

          for (const m of clarusMigrations) {
            await m.up(() => {})
          }

          const binding = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
          expect(binding).toBeDefined()
          expect(binding!.materializedAt).toBeUndefined()
        })(),
    })
  })

  test("migration is idempotent on repeat runs", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const agentId = "ag-idem2"
          const projectId = "pr-idem2"
          const taskId = "tk-idem2"
          const sessionID = "ses-idem2"

          // Seed V4 binding to legacy flat path (simulates pre-sharding data)
          const binding: ClarusTaskBindingV4 = {
            schemaVersion: 4,
            agentId,
            projectId,
            taskId,
            sessionID,
            workspacePath: "/tmp/ws",
            scopeID: scope.id,
            runID: "",
            subtaskID: "",
            phase: "",
            attempt: 0,
            title: taskId,
            taskInput: {},
            contextHydration: "unavailable",
            frozenAgent: "",
            assignmentState: "planned",
            assignmentInboxItemID: "",
            assignmentMessageID: "",
            status: "waiting",
            resultState: "idle",
            extendOutboxRequestIDs: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          const taskKey = `${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`
          const taskFlatPath = [...StoragePath.clarusBindingsRoot(), "tasks", taskKey]
          await Storage.write(taskFlatPath, binding)

          const sidecarPath = [...taskFlatPath, "_materialized"]
          await Storage.write(sidecarPath, { materializedAt: 1700000000000 })

          for (const m of clarusMigrations) {
            await m.up(() => {})
          }

          const binding1 = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
          expect(binding1!.materializedAt).toBe(1700000000000)

          for (const m of clarusMigrations) {
            await m.up(() => {})
          }

          const binding2 = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
          expect(binding2!.materializedAt).toBe(1700000000000)
        })(),
    })
  })

  test("migration handles outbox V1 records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: () =>
        using(async () => {
          const v1 = {
            schemaVersion: 1,
            requestID: "req-v1-mig",
            action: "task_result",
            agentId: "ag-v1",
            projectId: "pr-v1",
            state: "acknowledged",
            resolvedAt: 1699999999999,
            createdAt: 1699999999000,
            updatedAt: 1699999999500,
          }
          await Storage.write(StoragePath.clarusOutboxRequestKey("req-v1-mig"), v1)

          for (const m of clarusMigrations) {
            await m.up(() => {})
          }

          const read = await Storage.read<unknown>(StoragePath.clarusOutboxRequestKey("req-v1-mig"))
          const parsed = ClarusOutboxRecordV2.safeParse(read)
          expect(parsed.success).toBe(true)
          if (parsed.success) {
            expect(parsed.data.schemaVersion).toBe(2)
            expect(parsed.data.state).toBe("acknowledged")
          }
        })(),
    })
  })
})

// =========================================================================
// 7. Outbox V2 supports local_only state
// =========================================================================
describe("Outbox V2 local_only state", () => {
  test("ClarusOutboxRecordV2 validates with local_only state", () => {
    const result = ClarusOutboxRecordV2.safeParse({
      schemaVersion: 2,
      requestID: "req-lo-valid",
      action: "task_result",
      agentId: "ag-1",
      projectId: "pr-1",
      payload: {},
      payloadHash: payloadHash({}),
      state: "local_only" as ClarusOutboxStateV2,
      localOnlyAt: 1700000000000,
      preparedAt: 1699999999000,
    })
    expect(result.success).toBe(true)
  })

  test("ClarusOutboxStateV2 includes local_only", () => {
    const stateField = ClarusOutboxRecordV2.shape.state
    expect(stateField.options).toContain("local_only")
    expect(stateField.options).toContain("prepared")
    expect(stateField.options).toContain("dispatched")
    expect(stateField.options).toContain("acknowledged")
    expect(stateField.options).toContain("rejected")
    expect(stateField.options).toContain("ambiguous")
  })

  test("outbox record schema validates correctly with localOnlyAt field", () => {
    const result = ClarusOutboxRecordV2.safeParse({
      schemaVersion: 2,
      requestID: "req-ts",
      action: "task_result",
      agentId: "ag-1",
      projectId: "pr-1",
      payload: {},
      payloadHash: payloadHash({}),
      state: "local_only" as ClarusOutboxStateV2,
      preparedAt: 1000,
      localOnlyAt: 2000,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.localOnlyAt).toBe(2000)
    }
  })
})
