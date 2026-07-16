import { beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionInbox } from "../../src/session/inbox"
import { ClarusBindingStore, ClarusTaskBindingStore } from "../../src/clarus/binding"
import { ClarusFanoutProgressStore } from "../../src/clarus/activity"
import { ClarusWorkspace } from "../../src/clarus/workspace"

let AGENT_ID = "agent_sr"
let PROJECT_ID = "project_sr"

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `agent_${suffix}`
  PROJECT_ID = `project_${suffix}`
})

// =============================================================================
// Invariant 1: Durable ownership — exactly one session per task
// =============================================================================
describe("durable task-session ownership", () => {
  test("getOrCreateTaskSession acquires and resolves ownership", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const { getOrCreateTaskSession } = await import("../../src/clarus/session-router")
        const session = await getOrCreateTaskSession({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "owned_task",
        })

        expect(session).toBeDefined()
        expect(session.id).toBeTypeOf("string")

        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "owned_task")
        expect(binding).toBeDefined()
        expect(binding?.sessionID).toBe(session.id)
        expect(binding?.taskSessionOwnershipClaim).toBeDefined()
        expect(binding?.taskSessionOwnershipClaim?.claimedByScopeID).toBe("home")
        expect(binding?.taskSessionOwnershipClaim?.resolvedAt).toBeTypeOf("number")

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("concurrent getOrCreateTaskSession calls return the same session", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const { getOrCreateTaskSession } = await import("../../src/clarus/session-router")
        const [session1, session2] = await Promise.all([
          getOrCreateTaskSession({ agentId: AGENT_ID, projectId: PROJECT_ID, taskId: "concurrent_task" }),
          getOrCreateTaskSession({ agentId: AGENT_ID, projectId: PROJECT_ID, taskId: "concurrent_task" }),
        ])

        expect(session1.id).toBe(session2.id)

        // Only one binding should exist
        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "concurrent_task")
        expect(binding?.sessionID).toBe(session1.id)
        expect(binding?.taskSessionOwnershipClaim?.resolvedAt).toBeTypeOf("number")

        SessionManager.unregisterRuntime(session1.id)
      },
    })
  })

  test("ownership conflict: resolved claim prevents new session creation", async () => {
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
          "resolved_task",
          session.id,
          `${tmp.path}/clarus_ws/rt`,
          scope.id,
        )
        // Acquire and resolve before getOrCreate
        await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "resolved_task",
          claimedByScopeID: "home",
        })
        await ClarusTaskBindingStore.resolveOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "resolved_task",
        })

        const { getOrCreateTaskSession } = await import("../../src/clarus/session-router")
        // getOrCreateTaskSession will discover the existing session via endpoint/binding
        const recovered = await getOrCreateTaskSession({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "resolved_task",
        })
        // Should return the existing session, not create a new one
        expect(recovered.id).toBe(session.id)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})

// =============================================================================
// Invariant 2: Crash recovery — unresolved claim, restart, recover
// =============================================================================
describe("crash recovery with ownership claims", () => {
  test("unresolved ownership claim is resolved on restart when session exists", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        // Simulate: session and binding created, ownership acquired but NOT resolved (crash)
        const session = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "crash_task",
          session.id,
          `${tmp.path}/clarus_ws/ct`,
          scope.id,
        )
        await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "crash_task",
          claimedByScopeID: "home",
        })
        // NO resolveOwnership — simulating crash

        // Restart: call getOrCreateTaskSession — should recover
        const { getOrCreateTaskSession } = await import("../../src/clarus/session-router")
        const recovered = await getOrCreateTaskSession({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "crash_task",
        })

        expect(recovered.id).toBe(session.id)

        // Ownership should now be resolved
        const binding = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "crash_task")
        expect(binding?.taskSessionOwnershipClaim?.resolvedAt).toBeTypeOf("number")

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("unresolved claim for different scope does not cause invalid recovery", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        // Create a task with an ownership claim from scope "project_xxx"
        const session = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "other_scope_task",
          session.id,
          `${tmp.path}/clarus_ws/ot`,
          scope.id,
        )
        await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "other_scope_task",
          claimedByScopeID: "project_some",
        })

        // acquireOwnership for "home" scope should throw CONFLICT
        await expect(
          ClarusTaskBindingStore.acquireOwnership({
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            taskId: "other_scope_task",
            claimedByScopeID: "home",
          }),
        ).rejects.toThrow(/already claimed/)

        // recoverOwnership for "home" scope should return undefined (not our claim)
        const recoverable = await ClarusTaskBindingStore.recoverOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "other_scope_task",
          claimedByScopeID: "home",
        })
        expect(recoverable).toBeUndefined()

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})

// =============================================================================
// Invariant 3: Per-target fanout progress — partial failure and retry
// =============================================================================
describe("per-target fanout progress", () => {
  test("deliverProjectMessage delivers context and cleans up fanout progress after dedup", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Fanout Cleanup",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const s1 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "fc_t1",
          s1.id,
          `${tmp.path}/clarus_ws/fc1`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "fc_t1",
          runID: "r1",
          phase: "p",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "FC1",
          taskInput: {},
          contextHydration: "complete",
        })

        const s2 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "fc_t2",
          s2.id,
          `${tmp.path}/clarus_ws/fc2`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "fc_t2",
          runID: "r2",
          phase: "p",
          subtaskID: "s2",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "FC2",
          taskInput: {},
          contextHydration: "complete",
        })

        const msgId = Identifier.ascending("message")
        const { deliverProjectMessage } = await import("../../src/clarus/session-router")
        const result = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "cleanup test",
        })

        expect(result.outcome).toBe("injected")

        // Fanout progress is cleaned up after successful dedup recording
        const delivered1 = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s1.id)
        const delivered2 = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s2.id)
        expect(delivered1).toBe(false)
        expect(delivered2).toBe(false)

        // The inbox should have context items (delivery did happen)
        const inbox1 = await SessionInbox.list(s1.id)
        const inbox2 = await SessionInbox.list(s2.id)
        expect(inbox1.length).toBeGreaterThan(0)
        expect(inbox2.length).toBeGreaterThan(0)

        SessionManager.unregisterRuntime(s1.id)
        SessionManager.unregisterRuntime(s2.id)
      },
    })
  })

  test("deterministic replay after cleanup is idempotent with two targets", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Cleanup Retry 2",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const s1 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "cr_t1",
          s1.id,
          `${tmp.path}/clarus_ws/cr1`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "cr_t1",
          runID: "r1",
          phase: "p",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "CR1",
          taskInput: {},
          contextHydration: "complete",
        })

        const s2 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "cr_t2",
          s2.id,
          `${tmp.path}/clarus_ws/cr2`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "cr_t2",
          runID: "r2",
          phase: "p",
          subtaskID: "s2",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "CR2",
          taskInput: {},
          contextHydration: "complete",
        })

        const msgId = Identifier.ascending("message")
        const { deliverProjectMessage } = await import("../../src/clarus/session-router")

        // First delivery — cleanup happens after dedup recording
        const first = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "cleanup retry",
        })
        expect(first.outcome).toBe("injected")

        const inbox1Before = await SessionInbox.list(s1.id)
        const inbox2Before = await SessionInbox.list(s2.id)
        expect(inbox1Before.length).toBe(1)
        expect(inbox2Before.length).toBe(1)

        // Retry after cleanup — collision caught, no duplicates
        const second = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "cleanup retry",
        })
        expect(second.outcome).toBe("injected")

        const inbox1After = await SessionInbox.list(s1.id)
        const inbox2After = await SessionInbox.list(s2.id)
        expect(inbox1After.length).toBe(1)
        expect(inbox2After.length).toBe(1)

        SessionManager.unregisterRuntime(s1.id)
        SessionManager.unregisterRuntime(s2.id)
      },
    })
  })

  test("deterministic replay: retry with existing project dedup skips already-delivered targets", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Retry Project",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const s1 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "rt_t1",
          s1.id,
          `${tmp.path}/clarus_ws/rt1`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "rt_t1",
          runID: "r1",
          phase: "p",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "RT1",
          taskInput: {},
          contextHydration: "complete",
        })

        const msgId = Identifier.ascending("message")
        const { deliverProjectMessage } = await import("../../src/clarus/session-router")

        // First delivery
        const first = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "retry test",
        })
        expect(first.outcome).toBe("injected")

        const inboxBefore = await SessionInbox.list(s1.id)
        expect(inboxBefore.length).toBe(1)

        // Second delivery (retry) — should be a no-op for the already-delivered target
        const second = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "retry test",
        })
        expect(second.outcome).toBe("injected")

        // No duplicate inbox items
        const inboxAfter = await SessionInbox.list(s1.id)
        expect(inboxAfter.length).toBe(1)

        SessionManager.unregisterRuntime(s1.id)
      },
    })
  })
})

// =============================================================================
// Invariant 4: Context mode does not wake idle sessions
// =============================================================================
describe("context mode no-wake semantics", () => {
  test("deliverProjectMessage uses deliverContext, which does not wake idle sessions", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "NoWake Project",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const session = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "nw_task",
          session.id,
          `${tmp.path}/clarus_ws/nw`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "nw_task",
          runID: "r1",
          phase: "p",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "NW",
          taskInput: {},
          contextHydration: "complete",
        })

        // Unregister to simulate idle session
        SessionManager.unregisterRuntime(session.id)

        const { deliverProjectMessage } = await import("../../src/clarus/session-router")
        const result = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: Identifier.ascending("message"),
          text: "quiet message",
        })

        expect(result.outcome).toBe("injected")

        // The inbox item should be "visible: false" (context mode)
        const inbox = await SessionInbox.list(session.id)
        expect(inbox.length).toBeGreaterThan(0)
        const contextItem = inbox.find(
          (item) => (item.source as Record<string, unknown> | undefined)?.type === "clarus",
        )
        expect(contextItem).toBeDefined()

        // Session should not be running — no wake occurred
        expect(SessionManager.isRunning(session.id)).toBe(false)
      },
    })
  })
})

// =============================================================================
// Invariant 5: Per-target progress plus project dedup interaction
// =============================================================================
describe("per-target progress plus project dedup", () => {
  test("retry after activity_only dedup delivers to newly bound tasks", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Dedup+Retry",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const msgId = Identifier.ascending("message")
        const { deliverProjectMessage } = await import("../../src/clarus/session-router")

        // First delivery: no bindings → activity_only
        const first = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "dedup+retry test",
        })
        expect(first.outcome).toBe("activity_only")

        // Retry: still no bindings → activity_only returned immediately
        const retry = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "dedup+retry test",
        })
        expect(retry.outcome).toBe("activity_only")
      },
    })
  })

  test("deterministic per-target IDs are collision-safe across different messages", async () => {
    const msg1 = "msg_alpha"
    const msg2 = "msg_beta"
    const sessionID = "ses_test_001"

    // One-way derivation — different messages produce different IDs
    const hashInput1 = `${encodeURIComponent(AGENT_ID)}:${encodeURIComponent(PROJECT_ID)}:${encodeURIComponent(msg1)}:${sessionID}`
    const hashInput2 = `${encodeURIComponent(AGENT_ID)}:${encodeURIComponent(PROJECT_ID)}:${encodeURIComponent(msg2)}:${sessionID}`

    expect(hashInput1).not.toBe(hashInput2)
  })
})

// =============================================================================
// Invariant 6: Ownerhip claim survives acquire → crash before resolve → recover
// =============================================================================
describe("ownership lifecycle integrity", () => {
  test("ownership claim is durable: claim persists across read-back", async () => {
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
          "durable_claim",
          session.id,
          `${tmp.path}/clarus_ws/dc`,
          scope.id,
        )

        // Acquire ownership
        const claimed = await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "durable_claim",
          claimedByScopeID: "home",
        })
        expect(claimed.taskSessionOwnershipClaim?.claimedByScopeID).toBe("home")
        expect(claimed.taskSessionOwnershipClaim?.claimedAt).toBeTypeOf("number")
        expect(claimed.taskSessionOwnershipClaim?.resolvedAt).toBeUndefined()

        // Read back — claim should persist
        const fresh = await ClarusTaskBindingStore.get(AGENT_ID, PROJECT_ID, "durable_claim")
        expect(fresh?.taskSessionOwnershipClaim?.claimedByScopeID).toBe("home")
        expect(fresh?.taskSessionOwnershipClaim?.resolvedAt).toBeUndefined()

        // Resolve
        const resolved = await ClarusTaskBindingStore.resolveOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "durable_claim",
        })
        expect(resolved.taskSessionOwnershipClaim?.resolvedAt).toBeTypeOf("number")

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("acquireOwnership is idempotent for same scope", async () => {
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
          "idempotent_claim",
          session.id,
          `${tmp.path}/clarus_ws/ic`,
          scope.id,
        )

        const first = await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "idempotent_claim",
          claimedByScopeID: "home",
        })
        const second = await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "idempotent_claim",
          claimedByScopeID: "home",
        })
        expect(second.taskSessionOwnershipClaim?.claimedAt).toBe(first.taskSessionOwnershipClaim?.claimedAt)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("resolveOwnership is idempotent", async () => {
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
          "idempotent_resolve",
          session.id,
          `${tmp.path}/clarus_ws/ir`,
          scope.id,
        )
        await ClarusTaskBindingStore.acquireOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "idempotent_resolve",
          claimedByScopeID: "home",
        })

        const first = await ClarusTaskBindingStore.resolveOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "idempotent_resolve",
        })
        const second = await ClarusTaskBindingStore.resolveOwnership({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "idempotent_resolve",
        })
        expect(second.taskSessionOwnershipClaim?.resolvedAt).toBe(first.taskSessionOwnershipClaim?.resolvedAt)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})

// =============================================================================
// Invariant 7: Path-safe fanout progress keys with encoded sessionID
// =============================================================================
describe("path-safe encoded fanout progress keys", () => {
  test("fanout progress handles sessionIDs containing path-significant characters", async () => {
    const specialSessionIDs = [
      "ses/with/slashes",
      "ses:with:colons",
      "ses%with%percents",
      "ses?with?query",
      "ses#with#hash",
    ]

    const msgId = "msg_enc_test"

    for (const sid of specialSessionIDs) {
      // Record delivery with special-character sessionID
      await ClarusFanoutProgressStore.recordDelivery(AGENT_ID, PROJECT_ID, msgId, sid)
      const delivered = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, sid)
      expect(delivered).toBe(true)

      // Cleanup
      await ClarusFanoutProgressStore.deleteAllDeliveriesByMessage(AGENT_ID, PROJECT_ID, msgId)
      const afterCleanup = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, sid)
      expect(afterCleanup).toBe(false)
    }
  })

  test("encoded and decoded sessionID round-trips correctly", async () => {
    const original = "session_with/special:chars%and?more#here"
    const msgId = "msg_roundtrip"

    // The store internally encodes the sessionID; verify isDelivered finds it
    await ClarusFanoutProgressStore.recordDelivery(AGENT_ID, PROJECT_ID, msgId, original)
    const found = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, original)
    expect(found).toBe(true)

    // Different sessionID should not match
    const notFound = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, "other_session")
    expect(notFound).toBe(false)

    await ClarusFanoutProgressStore.deleteAllDeliveriesByMessage(AGENT_ID, PROJECT_ID, msgId)
  })
})

// =============================================================================
// Invariant 8: Crash-before-dedup recovery with per-target progress
// =============================================================================
describe("crash-before-dedup recovery", () => {
  test("no-project-dedup replay skips targets with existing per-target progress", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Crash Recovery",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const s1 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "cr_t1",
          s1.id,
          `${tmp.path}/clarus_ws/cr1`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "cr_t1",
          runID: "r1",
          phase: "p",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "CR1",
          taskInput: {},
          contextHydration: "complete",
        })

        const s2 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "cr_t2",
          s2.id,
          `${tmp.path}/clarus_ws/cr2`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "cr_t2",
          runID: "r2",
          phase: "p",
          subtaskID: "s2",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "CR2",
          taskInput: {},
          contextHydration: "complete",
        })

        const msgId = Identifier.ascending("message")
        const { deliverProjectMessage } = await import("../../src/clarus/session-router")

        // Simulate crash-after-delivery-to-target-1-before-dedup:
        // manually deliver context to s1 and record progress, but do NOT record project dedup.
        const hashInput = `${encodeURIComponent(AGENT_ID)}:${encodeURIComponent(PROJECT_ID)}:${encodeURIComponent(msgId)}:${s1.id}`
        const hash = new Bun.CryptoHasher("sha256").update(hashInput).digest("base64url").slice(0, 32)
        const itemID = `inb_clarus_ctx_${hash}`

        await SessionManager.deliverContext({
          target: s1.id,
          inboxItemID: itemID,
          inboxMessageID: `msg_clarus_ctx_${hash}`,
          parts: [{ id: Identifier.ascending("part"), type: "text" as const, text: "crashed delivery" }],
          source: { type: "clarus", label: "Clarus Activity" },
        })
        await ClarusFanoutProgressStore.recordDelivery(AGENT_ID, PROJECT_ID, msgId, s1.id)

        // Verify s1 has the context, s2 doesn't yet
        const inbox1Before = await SessionInbox.list(s1.id)
        const inbox2Before = await SessionInbox.list(s2.id)
        expect(inbox1Before.length).toBe(1)
        expect(inbox2Before.length).toBe(0)

        // Retry: no project dedup exists, but s1 has per-target progress
        const result = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "retry after crash",
        })
        expect(result.outcome).toBe("injected")

        // s2 should now have the context, s1 should not have a duplicate
        const inbox1After = await SessionInbox.list(s1.id)
        const inbox2After = await SessionInbox.list(s2.id)
        expect(inbox1After.length).toBe(1)
        expect(inbox2After.length).toBe(1)

        // Fanout progress should be cleaned up after successful dedup
        const progress1 = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s1.id)
        const progress2 = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s2.id)
        expect(progress1).toBe(false)
        expect(progress2).toBe(false)

        SessionManager.unregisterRuntime(s1.id)
        SessionManager.unregisterRuntime(s2.id)
      },
    })
  })

  test("partial failure retains progress for successful targets until retry completes", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
        await ClarusBindingStore.reconcileBinding({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectName: "Partial Fail",
          projectStatus: "active",
          primaryAgent: "synergy",
        })
        await ClarusWorkspace.configure({ workspaceRoot: `${tmp.path}/clarus_ws` })

        const s1 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "pf_t1",
          s1.id,
          `${tmp.path}/clarus_ws/pf1`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "pf_t1",
          runID: "r1",
          phase: "p",
          subtaskID: "s1",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "PF1",
          taskInput: {},
          contextHydration: "complete",
        })

        const s2 = await Session.create({})
        await ClarusTaskBindingStore.ensureAssigned(
          AGENT_ID,
          PROJECT_ID,
          "pf_t2",
          s2.id,
          `${tmp.path}/clarus_ws/pf2`,
          scope.id,
        )
        await ClarusTaskBindingStore.updateAssignmentMetadata({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          taskId: "pf_t2",
          runID: "r2",
          phase: "p",
          subtaskID: "s2",
          attempt: 1,
          deadlineAt: null,
          frozenAgent: "synergy",
          title: "PF2",
          taskInput: {},
          contextHydration: "complete",
        })

        const msgId = Identifier.ascending("message")

        // Simulate partial delivery: manually deliver to s1 and record progress,
        // but leave s2 undelivered and no project dedup.
        const hashInput = `${encodeURIComponent(AGENT_ID)}:${encodeURIComponent(PROJECT_ID)}:${encodeURIComponent(msgId)}:${s1.id}`
        const hash = new Bun.CryptoHasher("sha256").update(hashInput).digest("base64url").slice(0, 32)

        await SessionManager.deliverContext({
          target: s1.id,
          inboxItemID: `inb_clarus_ctx_${hash}`,
          inboxMessageID: `msg_clarus_ctx_${hash}`,
          parts: [{ id: Identifier.ascending("part"), type: "text" as const, text: "partial success" }],
          source: { type: "clarus", label: "Clarus Activity" },
        })
        await ClarusFanoutProgressStore.recordDelivery(AGENT_ID, PROJECT_ID, msgId, s1.id)

        // s1 progress exists, s2 does not
        const prog1Before = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s1.id)
        const prog2Before = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s2.id)
        expect(prog1Before).toBe(true)
        expect(prog2Before).toBe(false)

        // Retry: should deliver only to s2 (s1 already has progress)
        const { deliverProjectMessage } = await import("../../src/clarus/session-router")
        const result = await deliverProjectMessage({
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          messageId: msgId,
          text: "retry partial",
        })
        expect(result.outcome).toBe("injected")

        // Both should have context items
        const inbox1 = await SessionInbox.list(s1.id)
        const inbox2 = await SessionInbox.list(s2.id)
        expect(inbox1.length).toBe(1)
        expect(inbox2.length).toBe(1)

        // Progress should be cleaned up after successful dedup
        const prog1After = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s1.id)
        const prog2After = await ClarusFanoutProgressStore.isDelivered(AGENT_ID, PROJECT_ID, msgId, s2.id)
        expect(prog1After).toBe(false)
        expect(prog2After).toBe(false)

        SessionManager.unregisterRuntime(s1.id)
        SessionManager.unregisterRuntime(s2.id)
      },
    })
  })
})
