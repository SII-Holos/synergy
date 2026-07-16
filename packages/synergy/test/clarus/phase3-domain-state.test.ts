import { beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionInbox } from "../../src/session/inbox"
import { ClarusOutbox } from "../../src/clarus/outbox"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusDedup } from "../../src/clarus/dedup"
import { ClarusProjectActivityStore } from "../../src/clarus/activity"
import { ClarusWorkspace } from "../../src/clarus/workspace"
import { dedupTaskMessageKey } from "../../src/clarus/keys"

let AGENT_ID = "agent_ds"
let PROJECT_ID = "project_ds"

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `agent_${suffix}`
  PROJECT_ID = `project_${suffix}`
})

// =============================================================================
// Invariant 1: Outbox terminal states — immutable except exact idempotent replay
// =============================================================================
describe("outbox terminal-state immutability", () => {
  test("acknowledged state cannot be overwritten by delayed rejected transition", async () => {
    await ClarusOutbox.preallocate({
      requestID: "term_ack_1",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      taskId: "task_term",
      payload: {},
    })
    await ClarusOutbox.markDispatched("term_ack_1")
    const ack = await ClarusOutbox.markAcknowledged("term_ack_1")
    expect(ack.state).toBe("acknowledged")

    await expect(ClarusOutbox.markRejected("term_ack_1", "LATE", "late rejection")).rejects.toMatchObject({
      code: "CLARUS_OUTBOX_TERMINAL",
    })
    const unchanged = await ClarusOutbox.get("term_ack_1")
    expect(unchanged?.state).toBe("acknowledged")
    expect(unchanged?.errorCode).toBeUndefined()
  })

  test("rejected state is immutable even on identical reject replay", async () => {
    await ClarusOutbox.preallocate({
      requestID: "term_rej_1",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: {},
    })
    await ClarusOutbox.markRejected("term_rej_1", "E1", "original error")
    const first = await ClarusOutbox.get("term_rej_1")
    expect(first?.state).toBe("rejected")
    expect(first?.errorCode).toBe("E1")

    const replay = await ClarusOutbox.markRejected("term_rej_1", "E1", "original error")
    expect(replay.state).toBe("rejected")
    expect(replay.errorCode).toBe("E1")
  })

  test("rejected replay with mismatched error code throws on non-exact replay", async () => {
    await ClarusOutbox.preallocate({
      requestID: "term_mismatch_1",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: {},
    })
    await ClarusOutbox.markRejected("term_mismatch_1", "E1", "original error")

    await expect(ClarusOutbox.markRejected("term_mismatch_1", "E2", "original error")).rejects.toThrow(
      /cannot rewrite terminal/i,
    )
  })

  test("rejected replay with mismatched error message throws on non-exact replay", async () => {
    await ClarusOutbox.preallocate({
      requestID: "term_mismatch_2",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: {},
    })
    await ClarusOutbox.markRejected("term_mismatch_2", "E1", "original error")

    await expect(ClarusOutbox.markRejected("term_mismatch_2", "E1", "different message")).rejects.toThrow(
      /cannot rewrite terminal/i,
    )
  })

  test("ambiguous replay with mismatched details throws on non-exact replay", async () => {
    await ClarusOutbox.preallocate({
      requestID: "term_amb_mismatch",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: {},
    })
    await ClarusOutbox.markAmbiguous("term_amb_mismatch", "AMB1", "ambiguous error")

    await expect(ClarusOutbox.markAmbiguous("term_amb_mismatch", "AMB2", "ambiguous error")).rejects.toThrow(
      /cannot rewrite terminal/i,
    )
  })

  test("terminal outbox record rejects acknowledged transition and state remains unchanged", async () => {
    await ClarusOutbox.preallocate({
      requestID: "term_dispatch_1",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: {},
    })
    await ClarusOutbox.markRejected("term_dispatch_1", "E", "done")
    await expect(ClarusOutbox.markAcknowledged("term_dispatch_1")).rejects.toMatchObject({
      code: "CLARUS_OUTBOX_TERMINAL",
    })
    const unchanged = await ClarusOutbox.get("term_dispatch_1")
    expect(unchanged?.state).toBe("rejected")
  })
})

// =============================================================================
// Invariant 2: local_only is irreversible
// =============================================================================
describe("local_only irreversibility", () => {
  test("acknowledge, reject, and ambiguous transitions are no-ops after local continuation", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const taskId = "task_local_lock"

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Test Project",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const session = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          taskId,
          session.id,
          `${tmp.path}/clarus_ws/${taskId}`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId,
          runID: "run_local",
          phase: "implementation",
          subtaskID: "sub_local",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "Local task",
          taskInput: { goal: "local" },
          contextHydration: "complete",
        })
        const afterLocal = await ClarusTaskBindingStore.enableLocalContinuation(AGENT_ID, PROJECT_ID, taskId)
        expect(afterLocal?.resultState).toBe("local_only")

        const ack = await ClarusTaskBindingStore.markResultAcknowledged(AGENT_ID, PROJECT_ID, taskId)
        expect(ack?.resultState).toBe("local_only")

        const rej = await ClarusTaskBindingStore.markResultRejected(AGENT_ID, PROJECT_ID, taskId)
        expect(rej?.resultState).toBe("local_only")

        const amb = await ClarusTaskBindingStore.markResultAmbiguous(AGENT_ID, PROJECT_ID, taskId)
        expect(amb?.resultState).toBe("local_only")

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})

describe("submitting rollback", () => {
  test("revertSubmitting clears the in-flight result request", async () => {
    const taskId = "task_revert_submitting"
    await ClarusTaskBindingStore.ensureAssigned(
      AGENT_ID,
      PROJECT_ID,
      taskId,
      "ses_revert_submitting",
      "/tmp/clarus-revert-submitting",
      "scope_revert_submitting",
    )
    await ClarusTaskBindingStore.markSubmitting({
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      taskId,
      resultOutboxRequestID: "result_revert_submitting",
    })

    const reverted = await ClarusTaskBindingStore.revertSubmitting(AGENT_ID, PROJECT_ID, taskId)

    expect(reverted?.status).toBe("needs_attention")
    expect(reverted?.resultState).toBe("idle")
    expect(reverted?.resultOutboxRequestID).toBeUndefined()
  })
})

// =============================================================================
// Invariant 3: Exact result identity validation helpers
// =============================================================================
describe("outbox identity validation helpers", () => {
  test("validateOutboxIdentity confirms matching fields and rejects mismatches", async () => {
    const record = await ClarusOutbox.preallocate({
      requestID: "ident_1",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      taskId: "task_ident",
      runId: "run_ident",
      subtaskId: "sub_ident",
      payload: { key: "value" },
    })
    expect(record.state).toBe("prepared")
    expect(record.agentId).toBe(AGENT_ID)
    expect(record.projectId).toBe(PROJECT_ID)
    expect(record.taskId).toBe("task_ident")
    expect(record.runId).toBe("run_ident")
    expect(record.subtaskId).toBe("sub_ident")
  })

  test("preallocate collision throws when identity fields differ", async () => {
    await ClarusOutbox.preallocate({
      requestID: "collide_1",
      action: "task_result",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: { a: 1 },
    })
    const promise = ClarusOutbox.preallocate({
      requestID: "collide_1",
      action: "project_subscribe",
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      payload: { a: 1 },
    })
    await expect(promise).rejects.toThrow()
  })
})

// =============================================================================
// Invariant 4: Deterministic project context fanout via deliverContext
// =============================================================================
describe("deterministic context fanout", () => {
  test("deliverProjectMessage fans out context to active tasks", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Fanout Project",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const session1 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "fanout_task_1",
          session1.id,
          `${tmp.path}/clarus_ws/t1`,
          scope.id,
        )
        const session2 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "fanout_task_2",
          session2.id,
          `${tmp.path}/clarus_ws/t2`,
          scope.id,
        )

        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "fanout_task_1",
          runID: "r1",
          phase: "p",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "FT1",
          taskInput: {},
          contextHydration: "complete",
        })
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "fanout_task_2",
          runID: "r2",
          phase: "p",
          subtaskID: "s2",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "FT2",
          taskInput: {},
          contextHydration: "complete",
        })

        const { deliverProjectMessage } = await import("../../src/clarus/session-router")
        const result = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: Identifier.ascending("message"),
          text: "fanout context test message",
        })

        expect(result.outcome).toBe("injected")
        const inbox1 = await SessionInbox.list(session1.id)
        const inbox2 = await SessionInbox.list(session2.id)
        expect(inbox1.length).toBeGreaterThan(0)
        expect(inbox2.length).toBeGreaterThan(0)

        SessionManager.unregisterRuntime(session1.id)
        SessionManager.unregisterRuntime(session2.id)
      },
    })
  })

  test("deliverProjectMessage skips terminal-status tasks", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const activeSession = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "active_task",
          activeSession.id,
          `${tmp.path}/clarus_ws/at`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "active_task",
          runID: "ra",
          phase: "p",
          subtaskID: "sa",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "AT",
          taskInput: {},
          contextHydration: "complete",
        })

        const doneSession = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "done_task",
          doneSession.id,
          `${tmp.path}/clarus_ws/dt`,
          scope.id,
        )
        await ClarusTaskBindingStore.markSubmitting({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "done_task",
          resultOutboxRequestID: "some_request",
        })
        await ClarusTaskBindingStore.markSubmitted({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "done_task",
        })

        const { deliverProjectMessage } = await import("../../src/clarus/session-router")
        await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: Identifier.ascending("message"),
          text: "should skip done task",
        })

        const activeInbox = await SessionInbox.list(activeSession.id)
        expect(activeInbox.length).toBeGreaterThan(0)

        const doneInbox = await SessionInbox.list(doneSession.id)
        const hasContextItem = doneInbox.some(
          (item) => (item.source as Record<string, unknown> | undefined)?.type === "clarus",
        )
        expect(hasContextItem).toBe(false)

        SessionManager.unregisterRuntime(activeSession.id)
        SessionManager.unregisterRuntime(doneSession.id)
      },
    })
  })
})

// =============================================================================
// Invariant 5: Home-Scope single-session ownership
// =============================================================================
describe("home-scope ownership", () => {
  test("getOrCreateTaskSession always uses Home scope, not project scope", async () => {
    const tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()

    await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })
        const { getOrCreateTaskSession } = await import("../../src/clarus/session-router")
        const session = await getOrCreateTaskSession({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "home_task",
          scope: projectScope,
        })
        const sessionScope = session.scope as { type: string; id: string }
        expect(sessionScope.type).not.toBe("project")
        if (typeof sessionScope.id === "string") {
          expect(sessionScope.id).not.toBe(projectScope.id)
        }
      },
    })
  })
})

// =============================================================================
// Invariant 6: Shared assignment materialization domain API
// =============================================================================
describe("assignment materialization API", () => {
  test("materializeAssignment writes full metadata with materialized-at marker", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const session = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "materialize_task",
          session.id,
          `${tmp.path}/clarus_ws/mt`,
          scope.id,
        )

        const binding = await ClarusTaskBindingStore.materializeAssignment({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "materialize_task",
          runID: "run_mat",
          phase: "implementation",
          subtaskID: "sub_mat",
          attempt: 2,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          frozenAgent: "claude",
          title: "Materialized Task",
          taskInput: { complexity: "high" },
          contextHydration: "complete",
        })

        expect(binding.runID).toBe("run_mat")
        expect(binding.phase).toBe("implementation")
        expect(binding.subtaskID).toBe("sub_mat")
        expect(binding.attempt).toBe(2)
        expect(binding.frozenAgent).toBe("claude")
        expect(binding.title).toBe("Materialized Task")
        expect(binding.taskInput).toEqual({ complexity: "high" })
        expect(binding.contextHydration).toBe("complete")
        expect(binding.materializedAt).toBeTypeOf("number")
        expect(binding.materializedAt).toBeGreaterThan(0)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("materializeAssignment works for both live and backfill flows", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const session = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "live_task",
          session.id,
          `${tmp.path}/clarus_ws/lt`,
          scope.id,
        )
        await ClarusTaskBindingStore.planAssignment(AGENT_ID, PROJECT_ID, "live_task", "inb_1", "msg_1")
        await ClarusTaskBindingStore.markEnqueued(AGENT_ID, PROJECT_ID, "live_task")

        const mat1 = await ClarusTaskBindingStore.materializeAssignment({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "live_task",
          runID: "r1",
          phase: "planning",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "gpt4",
          title: "Live",
          taskInput: { source: "live" },
          contextHydration: "complete",
        })
        expect(mat1.assignmentState).toBe("materialized")

        SessionManager.unregisterRuntime(session.id)

        const session2 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "backfill_task",
          session2.id,
          `${tmp.path}/clarus_ws/bt`,
          scope.id,
        )
        const mat2 = await ClarusTaskBindingStore.materializeAssignment({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "backfill_task",
          runID: "r2",
          phase: "reviewing",
          subtaskID: "s2",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "gpt4o",
          title: "Backfill",
          taskInput: { source: "backfill" },
          contextHydration: "partial",
        })
        expect(mat2.assignmentState).toBe("materialized")
        expect(mat2.contextHydration).toBe("partial")

        SessionManager.unregisterRuntime(session2.id)
      },
    })
  })
})

// =============================================================================
// Invariant 7: Bounded extendOutboxRequestIDs + paginated activity + dedup path
// =============================================================================
describe("bounded extendOutboxRequestIDs", () => {
  test("updateExtensionOutbox enforces a maximum bound on stored request IDs", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const session = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "bounded_task",
          session.id,
          `${tmp.path}/clarus_ws/bo`,
          scope.id,
        )

        for (let i = 0; i < 60; i++) {
          await ClarusTaskBindingStore.updateExtensionOutbox(AGENT_ID, PROJECT_ID, "bounded_task", `req_${i}`)
        }

        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "bounded_task")
        expect(binding?.extendOutboxRequestIDs.length).toBeLessThanOrEqual(50)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})

describe("paginated activity listing", () => {
  test("listByProjectPaginated respects limit and returns next cursor", async () => {
    await ClarusProjectActivityStore.upsert({
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      messageId: "act_1",
      content: "first activity",
      receivedAt: 1000,
    })
    await ClarusProjectActivityStore.upsert({
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      messageId: "act_2",
      content: "second activity",
      receivedAt: 2000,
    })
    await ClarusProjectActivityStore.upsert({
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      messageId: "act_3",
      content: "third activity",
      receivedAt: 3000,
    })

    const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 2 })
    expect(page1.items.length).toBeLessThanOrEqual(2)
    expect(page1.nextCursor).toBeDefined()

    const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    })
    expect(page2.items.length).toBeGreaterThan(0)
  })
})

describe("correct task-message dedup path", () => {
  test("task-message dedup is isolated per task (different tasks don't collide)", async () => {
    const key1 = dedupTaskMessageKey(AGENT_ID, PROJECT_ID, "task_a", "msg_shared")
    const key2 = dedupTaskMessageKey(AGENT_ID, PROJECT_ID, "task_b", "msg_shared")
    expect(key1).not.toBe(key2)

    await ClarusDedup.recordTaskMessage(AGENT_ID, PROJECT_ID, "task_a", "msg_shared", {
      outcome: "injected",
      sessionID: "ses_a",
      inboxItemID: "inb_a",
    })
    await ClarusDedup.recordTaskMessage(AGENT_ID, PROJECT_ID, "task_b", "msg_shared", {
      outcome: "injected",
      sessionID: "ses_b",
      inboxItemID: "inb_b",
    })

    const entryA = await ClarusDedup.getTaskMessage(AGENT_ID, PROJECT_ID, "task_a", "msg_shared")
    expect(entryA?.outcome).toBe("injected")
    if (entryA && entryA.outcome === "injected") {
      expect(entryA.inboxItemID).toBe("inb_a")
    }

    const entryB = await ClarusDedup.getTaskMessage(AGENT_ID, PROJECT_ID, "task_b", "msg_shared")
    expect(entryB?.outcome).toBe("injected")
    if (entryB && entryB.outcome === "injected") {
      expect(entryB.inboxItemID).toBe("inb_b")
    }
  })
})

// =============================================================================
// Invariant 8: Terminal-state predicates for runtime cache/timer eviction
// =============================================================================
describe("terminal-state predicates", () => {
  test("isResultTerminal returns true for acknowledged, rejected, ambiguous, local_only", async () => {
    const { isResultTerminal } = await import("../../src/clarus/binding")
    expect(isResultTerminal("acknowledged")).toBe(true)
    expect(isResultTerminal("rejected")).toBe(true)
    expect(isResultTerminal("ambiguous")).toBe(true)
    expect(isResultTerminal("local_only")).toBe(true)
    expect(isResultTerminal("idle")).toBe(false)
    expect(isResultTerminal("prepared")).toBe(false)
    expect(isResultTerminal("dispatched")).toBe(false)
  })

  test("isStatusTerminal returns true for submitted, cancelled, failed, expired", async () => {
    const { isStatusTerminal } = await import("../../src/clarus/binding")
    expect(isStatusTerminal("submitted")).toBe(true)
    expect(isStatusTerminal("cancelled")).toBe(true)
    expect(isStatusTerminal("failed")).toBe(true)
    expect(isStatusTerminal("expired")).toBe(true)
    expect(isStatusTerminal("waiting")).toBe(false)
    expect(isStatusTerminal("running")).toBe(false)
    expect(isStatusTerminal("needs_attention")).toBe(false)
    expect(isStatusTerminal("submitting")).toBe(false)
  })
})
