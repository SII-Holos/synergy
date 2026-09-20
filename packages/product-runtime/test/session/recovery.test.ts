import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-workflows/blueprint/loop-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { LatticeStore } from "@ericsanchezok/synergy-workflows/lattice/store"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import * as SessionWorking from "@ericsanchezok/synergy-harness/session/working"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import "@ericsanchezok/synergy-product-runtime/product-registration"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"

Log.init({ print: false })

function assertExists<T>(value: T | undefined): asserts value is T {
  if (value === undefined) throw new Error("expected defined value")
}

async function createPendingUserMessage(sessionID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
}

async function createIncompleteAssistant(sessionID: string) {
  const user = await createPendingUserMessage(sessionID)
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: process.cwd(), root: process.cwd() },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

async function createBlueprintNote() {
  return NoteStore.create({
    title: "Restart-safe Blueprint",
    kind: "blueprint",
    blueprint: {
      description: "Recover loop references after restart.",
    },
  })
}

describe("SessionRecovery.reconcileRuntimeState", () => {
  test("leaves the pause latch to the pause reconcile and records it there", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const session = await Session.create({})
        await createIncompleteAssistant(session.id)

        // Workflow-reference reconciliation repairs durable references and
        // nothing else. A session that merely stopped mid-turn must not be
        // latched by it, or the two startup steps would own the same fact.
        await SessionRecovery.reconcileRuntimeState({ scopeID, apply: true })
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()

        // The pause reconcile is the step that records the interruption, and it
        // records it without resuming anything on the user's behalf.
        await SessionInvoke.reconcilePausedSessions(scopeID)
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("interrupted")
        expect(SessionManager.isRunning(session.id)).toBe(false)
      },
    })
  })

  test("keeps the interrupted turn resumable instead of repairing or driving it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const session = await Session.create({})
        const assistant = await createIncompleteAssistant(session.id)

        await SessionRecovery.reconcileRuntimeState({ scopeID, apply: true })
        await SessionInvoke.reconcilePausedSessions(scopeID)

        // The breakpoint is the whole reason the session is worth continuing:
        // terminalizing it here would make Continue a silent no-op, so startup
        // must leave the assistant exactly as the stopped turn left it.
        const messages = await Session.messages({ sessionID: session.id, raw: true })
        const assistantMessage = messages.find((message) => message.info.id === assistant.id)
        assertExists(assistantMessage)
        expect((assistantMessage.info as MessageV2.Assistant).time.completed).toBeUndefined()
        expect(SessionProgress.isTerminalAssistant(assistantMessage.info as MessageV2.Assistant)).toBe(false)

        const statuses = await SessionManager.listStatuses(scopeID)
        expect(statuses[session.id]?.type).toBe("paused")
        expect(SessionManager.isRunning(session.id)).toBe(false)
      },
    })
  })

  test("restores active BlueprintLoop note and execution session bindings", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        // A pending stop request is durable evidence that this loop still owes a
        // verdict, so recovery preserves it rather than adjudicating it as
        // orphaned.
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "running",
          stopRequest: {
            summary: "Resume this loop after restart",
            requestedAt: Date.now(),
            requesterSessionID: session.id,
            requesterMessageID: "msg_restart_evidence",
          },
        })
        await NoteStore.update(ScopeContext.current.scope.id, note.id, {
          blueprint: { activeLoopID: null },
        })

        await SessionRecovery.reconcileRuntimeState({
          scopeID: ScopeContext.current.scope.id,
          apply: true,
        })

        const refreshedSession = await Session.get(session.id)
        const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
        expect(refreshedSession.blueprint).toEqual({ loopID: loop.id, loopRole: "execution" })
        expect(refreshedNote.blueprint?.activeLoopID).toBe(loop.id)

        // A loop with a live driver is not stopped: the loop record is preserved
        // and no pause is recorded against the session, because a persisted loop
        // is a record of intent rather than evidence that a turn is running.
        const scopeID = ScopeContext.current.scope.id
        expect((await BlueprintLoopStore.get(scopeID, loop.id)).status).toBe("running")
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        expect((await SessionManager.listStatuses(scopeID))[session.id]).toBeUndefined()
      },
    })
  })

  test("clears dangling terminal BlueprintLoop note and session references", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "completed" })
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        await NoteStore.update(ScopeContext.current.scope.id, note.id, {
          blueprint: { activeLoopID: loop.id },
        })

        await SessionRecovery.reconcileRuntimeState({
          scopeID: ScopeContext.current.scope.id,
          apply: true,
        })

        const refreshedSession = await Session.get(session.id)
        const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
        expect(refreshedSession.blueprint?.loopID).toBeUndefined()
        expect(refreshedSession.blueprint?.loopRole).toBeUndefined()
        expect(refreshedNote.blueprint?.activeLoopID).toBeUndefined()
      },
    })
  })

  test("projects no status for an active Lattice workflow session and kicks no continuation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const session = await Session.create({})
        const run = await LatticeStore.reset({ sessionID: session.id, mode: "auto", goal: "Recover only" })
        await Session.update(session.id, (draft) => {
          draft.workflow = {
            kind: "lattice",
            runID: run.id,
            mode: run.mode,
          }
        })

        // Lattice reconciles its own run through its own startup controller, so
        // session recovery must report nothing for it and must not fabricate a
        // pause the user never asked for.
        expect(await SessionWorking.resolve(session.id)).toBeUndefined()
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        const runtime = SessionManager.getRuntime(session.id)
        expect(runtime?.owner).toBeUndefined()
        expect(runtime?.status).toEqual({ type: "idle" })
        expect((await SessionManager.listStatuses(scopeID))[session.id]).toBeUndefined()
      },
    })
  })
})

describe("a durable stop intent survives restart without being driven", () => {
  test("preserves an unbound Light Loop stop intent without resuming it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Finish the task",
            stopRequest: {
              summary: "Task complete",
              requestedAt: Date.now(),
              requesterSessionID: session.id,
              requesterMessageID: Identifier.ascending("message"),
            },
          }
        })

        await SessionRecovery.reconcileRuntimeState({ scopeID, apply: true })
        await SessionInvoke.reconcilePausedSessions(scopeID)

        // The stop intent is meant to be consumed by the continuation kernel
        // when the turn next runs, so reconciliation must leave it in place.
        const recovered = await Session.get(session.id)
        expect(recovered.workflow?.kind).toBe("lightloop")
        if (recovered.workflow?.kind !== "lightloop") throw new Error("Light Loop workflow missing")
        expect(recovered.workflow.stopRequest?.summary).toBe("Task complete")

        // Startup no longer resumes anything: the request is recorded, not acted
        // on, and the session is neither driven nor paused for it.
        expect(SessionManager.isRunning(session.id)).toBe(false)
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
      },
    })
  })

  test("preserves a completed Light Loop review whose terminal review tool did not settle", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const execution = await Session.create({})
        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            taskID: "ctx_completed_light_loop_review",
            parentSessionID: execution.id,
            parentMessageID: Identifier.ascending("message"),
            description: "Review Light Loop",
            agent: "lightloop-reviewer",
            startedAt: Date.now(),
            completedAt: Date.now(),
            status: "completed",
          },
        })
        await Session.update(execution.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Finish the task",
            stopRequest: {
              summary: "Task complete",
              requestedAt: Date.now(),
              requesterSessionID: execution.id,
              requesterMessageID: Identifier.ascending("message"),
              reviewSessionID: reviewer.id,
              reviewTaskID: reviewer.cortex?.taskID,
            },
          }
        })

        await SessionRecovery.reconcileRuntimeState({ scopeID, apply: true })
        await SessionInvoke.reconcilePausedSessions(scopeID)

        // A completed review is durable evidence that a verdict is still owed,
        // so the binding to the reviewer must survive: it is what lets the
        // continuation kernel finish the review instead of restarting it.
        const recovered = await Session.get(execution.id)
        expect(recovered.workflow?.kind).toBe("lightloop")
        if (recovered.workflow?.kind !== "lightloop") throw new Error("Light Loop workflow missing")
        expect(recovered.workflow.stopRequest?.reviewSessionID).toBe(reviewer.id)
        expect(recovered.workflow.stopRequest?.reviewTaskID).toBe(reviewer.cortex?.taskID)

        expect(SessionManager.isRunning(execution.id)).toBe(false)
        expect(await SessionLifecycle.snapshot(execution.id)).toBeUndefined()
      },
    })
  })

  test("preserves an interrupted Blueprint audit without losing its stop intent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execution = await Session.create({})
        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            taskID: "cortex-interrupted-blueprint-review",
            parentSessionID: execution.id,
            parentMessageID: Identifier.ascending("message"),
            description: "Audit BlueprintLoop",
            agent: "supervisor",
            startedAt: Date.now(),
            completedAt: Date.now(),
            status: "interrupted",
          },
        })
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: execution.id,
        })
        const scopeID = ScopeContext.current.scope.id
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })
        await BlueprintLoopStore.recordStopRequest(scopeID, loop.id, {
          summary: "Blueprint complete",
          requestedAt: Date.now(),
          requesterSessionID: execution.id,
          requesterMessageID: Identifier.ascending("message"),
        })
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
          status: "auditing",
          auditSessionID: reviewer.id,
          auditTaskID: reviewer.cortex?.taskID,
        })

        await SessionRecovery.reconcileRuntimeState({ scopeID, apply: true })
        await SessionInvoke.reconcilePausedSessions(scopeID)

        // The stop intent is a durable driver, so the loop is not adjudicated as
        // orphaned and the audit binding stays exactly as the audit left it.
        const recovered = await BlueprintLoopStore.get(scopeID, loop.id)
        expect(recovered.status).toBe("auditing")
        expect(recovered.auditSessionID).toBe(reviewer.id)
        expect(recovered.auditTaskID).toBe(reviewer.cortex?.taskID)
        expect(recovered.stopRequest?.summary).toBe("Blueprint complete")

        expect(SessionManager.isRunning(execution.id)).toBe(false)
        expect(await SessionLifecycle.snapshot(execution.id)).toBeUndefined()
      },
    })
  })

  test("preserves a completed Blueprint audit whose terminal review tool did not settle", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execution = await Session.create({})
        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            taskID: "ctx_completed_blueprint_review",
            parentSessionID: execution.id,
            parentMessageID: Identifier.ascending("message"),
            description: "Audit BlueprintLoop",
            agent: "supervisor",
            startedAt: Date.now(),
            completedAt: Date.now(),
            status: "completed",
          },
        })
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: execution.id,
        })
        const scopeID = ScopeContext.current.scope.id
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })
        await BlueprintLoopStore.recordStopRequest(scopeID, loop.id, {
          summary: "Blueprint complete",
          requestedAt: Date.now(),
          requesterSessionID: execution.id,
          requesterMessageID: Identifier.ascending("message"),
        })
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
          status: "auditing",
          auditSessionID: reviewer.id,
          auditTaskID: reviewer.cortex?.taskID,
        })

        await SessionRecovery.reconcileRuntimeState({ scopeID, apply: true })
        await SessionInvoke.reconcilePausedSessions(scopeID)

        const recovered = await BlueprintLoopStore.get(scopeID, loop.id)
        expect(recovered.status).toBe("auditing")
        expect(recovered.auditSessionID).toBe(reviewer.id)
        expect(recovered.auditTaskID).toBe(reviewer.cortex?.taskID)
        expect(recovered.stopRequest?.summary).toBe("Blueprint complete")

        expect(SessionManager.isRunning(execution.id)).toBe(false)
        expect(await SessionLifecycle.snapshot(execution.id)).toBeUndefined()
      },
    })
  })
})

describe("SessionRecovery.recoverableStatuses", () => {
  test("reports the session's own pause and not a stored loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })

        // A persisted loop is a record of intent, not evidence of work, so it
        // must project no status on its own. Reporting one here is exactly what
        // used to pin a dead session in a state no control could clear.
        expect(await SessionRecovery.recoverableStatuses(scopeID)).toEqual({})

        // Once the session itself is paused, that latch is the status every
        // other client learns about, because recovery reads storage rather than
        // runtimes.
        await SessionLifecycle.pause({
          sessionID: session.id,
          reason: "workflow",
          description: "BlueprintLoop active",
        })
        const statuses = await SessionRecovery.recoverableStatuses(scopeID)
        expect(statuses[session.id]).toMatchObject({
          type: "paused",
          reason: "workflow",
          description: "BlueprintLoop active",
        })
      },
    })
  })

  test("returns empty record when no sessions need recovery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const statuses = await SessionRecovery.recoverableStatuses(ScopeContext.current.scope.id)
        expect(Object.keys(statuses)).toHaveLength(0)
      },
    })
  })

  test("includes audit session when loop is auditing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const execSession = await Session.create({})
        const auditSession = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: execSession.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
          status: "running",
          stopRequest: {
            summary: "Audit this loop after restart",
            requestedAt: Date.now(),
            requesterSessionID: execSession.id,
            requesterMessageID: "msg_audit_evidence",
          },
        })
        await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
          status: "auditing",
          auditSessionID: auditSession.id,
        })
        await SessionLifecycle.pause({
          sessionID: execSession.id,
          reason: "workflow",
          description: "BlueprintLoop active",
        })
        await SessionLifecycle.pause({
          sessionID: auditSession.id,
          reason: "workflow",
          description: "BlueprintLoop active",
        })

        // Both sides of an auditing loop are surfaced, because a pause on either
        // one is a session the user has to act on.
        const statuses = await SessionRecovery.recoverableStatuses(scopeID)
        expect(statuses[execSession.id]).toMatchObject({ type: "paused", reason: "workflow" })
        expect(statuses[auditSession.id]).toMatchObject({ type: "paused", reason: "workflow" })
      },
    })
  })
})

describe("SessionRecovery BlueprintLoop audit binding", () => {
  test("restores audit session binding when loop is auditing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execSession = await Session.create({})
        const auditSession = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: execSession.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "running",
          stopRequest: {
            summary: "Audit this loop after restart",
            requestedAt: Date.now(),
            requesterSessionID: execSession.id,
            requesterMessageID: "msg_audit_evidence",
          },
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "auditing",
          auditSessionID: auditSession.id,
        })

        // Wipe both session bindings to simulate crash before bind occurred
        await Session.update(execSession.id, (draft) => {
          draft.blueprint = undefined
        })
        await Session.update(auditSession.id, (draft) => {
          draft.blueprint = undefined
        })
        await NoteStore.update(ScopeContext.current.scope.id, note.id, {
          blueprint: { activeLoopID: null },
        })

        await SessionRecovery.reconcileRuntimeState({
          scopeID: ScopeContext.current.scope.id,
          apply: true,
        })

        const refreshedExec = await Session.get(execSession.id)
        const refreshedAudit = await Session.get(auditSession.id)
        const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
        expect(refreshedExec.blueprint).toEqual({ loopID: loop.id, loopRole: "execution" })
        expect(refreshedAudit.blueprint).toEqual({ loopID: loop.id, loopRole: "audit" })
        expect(refreshedNote.blueprint?.activeLoopID).toBe(loop.id)
      },
    })
  })
})

describe("SessionProgress.pendingReplyFor", () => {
  test("returns false when session has no messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { SessionProgress } = await import("@ericsanchezok/synergy-harness/session/progress")
        const session = await Session.create({})
        const result = await SessionProgress.pendingReplyFor({
          scopeID: ScopeContext.current.scope.id,
          sessionID: session.id,
        })
        expect(result).toBe(false)
      },
    })
  })

  test("returns true for session with pending user and no terminal assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { SessionProgress } = await import("@ericsanchezok/synergy-harness/session/progress")
        const session = await Session.create({})
        await createPendingUserMessage(session.id)
        const result = await SessionProgress.pendingReplyFor({
          scopeID: ScopeContext.current.scope.id,
          sessionID: session.id,
        })
        expect(result).toBe(true)
      },
    })
  })
  test("preserves pending reply order for legacy stable delivery message ids", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const oldRoot = await createPendingUserMessage(session.id)
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: oldRoot.id,
          rootID: oldRoot.id,
          time: { created: Date.now(), completed: Date.now() },
          modelID: "test-model",
          providerID: "test-provider",
          path: { cwd: tmp.path, root: tmp.path },
          mode: "test",
          agent: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })
        const legacyRootID = `msg_${"f".repeat(26)}`
        await Session.updateMessage({
          id: legacyRootID,
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test-provider", modelID: "test-model" },
          isRoot: true,
          rootID: legacyRootID,
          time: { created: Date.now() + 1 },
        })

        const orderedMessages = await Session.messages({ sessionID: session.id, raw: true })
        expect(orderedMessages.map((message) => message.info.id).at(-1)).toBe(legacyRootID)

        const result = await SessionProgress.pendingReplyFor({
          scopeID: ScopeContext.current.scope.id,
          sessionID: session.id,
        })

        expect(result).toBe(true)
      },
    })
  })
})

describe("SessionWorking resolution after restart", () => {
  test("projects no status for a Light Loop workflow without a live turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lightloop", instructions: "Recovery test" }
        })

        // A stored workflow is intent, not a running turn: projecting it as work
        // is what let a dead process pin a session forever.
        expect(await SessionWorking.resolve(session.id)).toBeUndefined()
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()

        // Verify no runtime was spun up
        const runtime = SessionManager.getRuntime(session.id)
        expect(runtime?.owner).toBeUndefined()
      },
    })
  })

  test("projects no status for a bound BlueprintLoop session without a latch", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })

        expect(await SessionWorking.resolve(session.id)).toBeUndefined()

        const runtime = SessionManager.getRuntime(session.id)
        expect(runtime?.owner).toBeUndefined()
      },
    })
  })
})
