import { describe, expect, mock, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowBridge } from "../../src/workflow-run/bridge"
import { WorkflowRunRecovery } from "../../src/workflow-run/recovery"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowTypes } from "../../src/workflow-run/types"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("WorkflowRunRecovery", () => {
  test("drains a transition outbox committed before restart", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({})
      const charter = WorkflowTypes.Charter.parse({
        id: "cht_recovery",
        version: 1,
        name: "Recovery",
        entityType: "task",
        entityInitialState: "queued",
        states: ["queued", "working", WorkflowTypes.BLOCKED_STATE],
        seats: [{ name: "worker", agent: "synergy", pool: 1, worktree: "none" }],
        transitions: [],
        time: { created: Date.now() },
      })
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: charter.version },
        title: "Recovery",
        bossSessionID: boss.id,
        seats: [],
        maxModelCalls: 0,
      })
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: run.id, role: "boss" }
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_recovery",
          runID: run.id,
          title: "Recover me",
          state: "working",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        })
        draft.pendingEffects = [
          {
            id: "wfv_recovery",
            transitionEventID: "wfv_transition",
            transitionID: "start",
            entityID: "wfe_recovery",
            effects: [{ name: "set_binding", args: { key: "recovered", value: "yes" } }],
            nextIndex: 0,
          },
        ]
      })

      await WorkflowRunRecovery.reconcile(scopeID)

      const recovered = await WorkflowRunStore.get(scopeID, run.id)
      expect(recovered.entities[0]?.bindings.recovered).toBe("yes")
      expect(recovered.pendingEffects).toHaveLength(0)
    })
  })

  test("redrives an eligible event transition left queued across restart", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({})
      const charter = WorkflowTypes.Charter.parse({
        id: "cht_recovery_redrive",
        version: 1,
        name: "Recovery redrive",
        entityType: "task",
        entityInitialState: "queued",
        states: ["queued", "working", WorkflowTypes.BLOCKED_STATE],
        seats: [{ name: "worker", agent: "synergy", pool: 1, worktree: "none" }],
        transitions: [
          {
            id: "start",
            from: "queued",
            to: "working",
            trigger: { kind: "event" },
            guards: [],
            effects: [],
          },
        ],
        time: { created: Date.now() },
      })
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: charter.version },
        title: "Recovery redrive",
        bossSessionID: boss.id,
        seats: [],
        maxModelCalls: 0,
      })
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: run.id, role: "boss" }
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_recovery_redrive",
          runID: run.id,
          title: "Queued entity",
          state: "queued",
          bindings: {},
          submissions: [],
          time: { created: now, updated: now, stateEntered: now },
        })
      })

      await WorkflowRunRecovery.reconcile(scopeID)

      expect((await WorkflowRunStore.get(scopeID, run.id)).entities[0]?.state).toBe("working")
    })
  })

  test("projects a persisted handoff message into one ack when restart missed the message bus event", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({})
      const seat = await Session.create({ parentID: boss.id })
      const charter = WorkflowTypes.Charter.parse({
        id: "cht_recovery_handoff_ack",
        version: 1,
        name: "Recover handoff acknowledgement",
        entityType: "task",
        entityInitialState: "waiting",
        states: ["waiting", WorkflowTypes.BLOCKED_STATE],
        seats: [{ name: "worker", agent: "synergy", pool: 1, worktree: "none" }],
        transitions: [],
        time: { created: Date.now() },
      })
      await CharterStore.put(scopeID, charter)
      const entityID = "wfe_recovery_handoff_ack"
      const handoffID = "wfh_recovery_handoff_ack"
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: charter.version },
        title: "Recover handoff acknowledgement",
        bossSessionID: boss.id,
        seats: [
          {
            seat: "worker",
            instance: 0,
            status: "working",
            sessionID: seat.id,
            entityID,
            lastEntityIDs: [],
          },
        ],
        maxModelCalls: 0,
      })
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: run.id, role: "boss" }
      })
      await Session.update(seat.id, (draft) => {
        draft.workflowRun = { runID: run.id, role: "seat", seat: "worker", instance: 0 }
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: entityID,
          runID: run.id,
          title: "Recover persisted handoff",
          state: "waiting",
          bindings: { seatSessionID: seat.id },
          submissions: [],
          assignedSeat: { seat: "worker", instance: 0 },
          pendingHandoffID: handoffID,
          time: { created: now, updated: now, stateEntered: now },
        })
      })
      const delivery = await SessionInbox.deliver({
        sessionID: seat.id,
        mode: "task",
        message: {
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "Recover this persisted handoff" }],
          metadata: { workflowRun: { runID: run.id, entityID, handoffID } },
        },
      })
      await SessionInbox.materializeItem(await SessionInbox.getStored(seat.id, delivery.itemID))
      await SessionInbox.commitReady(seat.id, [delivery.itemID])

      await WorkflowRunRecovery.reconcile(scopeID)
      await WorkflowRunRecovery.reconcile(scopeID)

      const acknowledgements = (await WorkflowRunStore.listEvents(scopeID, run.id)).filter(
        (event) => event.kind === "handoff_acked",
      )
      expect(acknowledgements).toHaveLength(1)
      expect(acknowledgements[0]?.data).toEqual({
        handoffID,
        sessionID: seat.id,
        messageID: delivery.messageID,
      })
    })
  })

  test("projects a completed durable contractor into one deliverable after a publish-boundary crash", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({})
      const charter = WorkflowTypes.Charter.parse({
        id: "cht_recovery_contractor_completed",
        version: 1,
        name: "Recover completed contractor",
        entityType: "task",
        entityInitialState: "waiting",
        states: ["waiting", "done", WorkflowTypes.BLOCKED_STATE],
        terminalStates: ["done"],
        seats: [{ name: "worker", agent: "synergy", pool: 1, worktree: "none" }],
        transitions: [
          {
            id: "contractor_completed",
            from: "waiting",
            to: "done",
            trigger: { kind: "event" },
            guards: [{ name: "submission_recorded", args: { kind: "deliverable", fresh: "true" } }],
            effects: [],
          },
        ],
        time: { created: Date.now() },
      })
      await CharterStore.put(scopeID, charter)
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: charter.id, version: charter.version },
        title: "Recover contractor",
        bossSessionID: boss.id,
        seats: [],
        maxModelCalls: 0,
      })
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: run.id, role: "boss" }
      })
      const stateEntered = Date.now()
      const entityID = "wfe_recovery_contractor_completed"
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: entityID,
          runID: run.id,
          title: "Recover contractor result",
          state: "waiting",
          bindings: {},
          submissions: [],
          time: { created: stateEntered, updated: stateEntered, stateEntered },
        })
      })
      const taskID = Identifier.short("cortex")
      const contractor = await Session.create({
        parentID: boss.id,
        cortex: {
          taskID,
          parentSessionID: boss.id,
          parentMessageID: Identifier.ascending("message"),
          description: "Recovered completed contractor",
          agent: "synergy",
          executionRole: "delegated_subagent",
          startedAt: stateEntered,
          completedAt: stateEntered + 1,
          status: "completed",
          visibility: "hidden",
          output: { mode: "summary", value: "Recovered implementation and verification." },
          owner: {
            kind: "workflow_run",
            runID: run.id,
            entityID,
            correlationID: "workflow-contractor-recovery-completed",
          },
        },
      })
      WorkflowBridge.init()

      await WorkflowRunRecovery.reconcile(scopeID)
      await WorkflowRunRecovery.reconcile(scopeID)

      const recovered = await WorkflowRunStore.get(scopeID, run.id)
      expect(recovered.entities[0]?.state).toBe("done")
      expect(recovered.entities[0]?.submissions).toEqual([
        {
          id: taskID,
          kind: "deliverable",
          seat: "contractor",
          sessionID: contractor.id,
          summary: "Recovered implementation and verification.",
          refs: [contractor.id],
          time: stateEntered + 1,
        },
      ])
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.filter((event) => event.kind === "submission_recorded")).toHaveLength(1)
      expect(events.filter((event) => event.kind === "contractor_finished")).toHaveLength(1)
    })
  })

  test.each(["error", "cancelled", "interrupted"] as const)(
    "projects a durable %s contractor into one terminal fact after restart",
    async (status) => {
      await withScope(async () => {
        const scopeID = ScopeContext.current.scope.id
        const boss = await Session.create({})
        const charter = WorkflowTypes.Charter.parse({
          id: `cht_recovery_contractor_${status}`,
          version: 1,
          name: `Recover ${status} contractor`,
          entityType: "task",
          entityInitialState: "waiting",
          states: ["waiting", "failed", WorkflowTypes.BLOCKED_STATE],
          terminalStates: ["failed"],
          seats: [{ name: "worker", agent: "synergy", pool: 1, worktree: "none" }],
          transitions: [
            {
              id: "contractor_terminal",
              from: "waiting",
              to: "failed",
              trigger: { kind: "event" },
              guards: [],
              effects: [],
            },
          ],
          time: { created: Date.now() },
        })
        await CharterStore.put(scopeID, charter)
        const run = await WorkflowRunStore.create({
          scopeID,
          charterRef: { id: charter.id, version: charter.version },
          title: "Recover contractor",
          bossSessionID: boss.id,
          seats: [],
          maxModelCalls: 0,
        })
        await Session.update(boss.id, (draft) => {
          draft.workflowRun = { runID: run.id, role: "boss" }
        })
        const stateEntered = Date.now()
        const entityID = `wfe_recovery_contractor_${status}`
        await WorkflowRunStore.update(scopeID, run.id, (draft) => {
          draft.entities.push({
            id: entityID,
            runID: run.id,
            title: "Recover contractor terminal state",
            state: "waiting",
            bindings: {},
            submissions: [],
            time: { created: stateEntered, updated: stateEntered, stateEntered },
          })
        })
        const taskID = Identifier.short("cortex")
        const contractor = await Session.create({
          parentID: boss.id,
          cortex: {
            taskID,
            parentSessionID: boss.id,
            parentMessageID: Identifier.ascending("message"),
            description: `Recovered ${status} contractor`,
            agent: "synergy",
            executionRole: "delegated_subagent",
            startedAt: stateEntered,
            completedAt: stateEntered + 1,
            status,
            visibility: "hidden",
            error: status === "error" ? "Contractor failed verification" : undefined,
            owner: {
              kind: "workflow_run",
              runID: run.id,
              entityID,
              correlationID: `workflow-contractor-recovery-${status}`,
            },
          },
        })
        WorkflowBridge.init()

        await WorkflowRunRecovery.reconcile(scopeID)
        await WorkflowRunRecovery.reconcile(scopeID)

        const recovered = await WorkflowRunStore.get(scopeID, run.id)
        expect(recovered.entities[0]?.state).toBe("failed")
        expect(recovered.entities[0]?.submissions).toHaveLength(0)
        const terminalFacts = (await WorkflowRunStore.listEvents(scopeID, run.id)).filter(
          (event) => event.kind === "contractor_finished",
        )
        expect(terminalFacts).toHaveLength(1)
        expect(terminalFacts[0]?.data).toMatchObject({
          taskID,
          status,
          sessionID: contractor.id,
          ...(status === "error" ? { error: "Contractor failed verification" } : {}),
        })
      })
    },
  )

  test("fails an active run whose Boss session was deleted", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: "cht_missing", version: 1 },
        title: "Missing Boss",
        bossSessionID: "ses_missing_boss",
        seats: [],
        maxModelCalls: 0,
      })

      await WorkflowRunRecovery.reconcile(scopeID)

      const failed = await WorkflowRunStore.get(scopeID, run.id)
      expect(failed.status).toBe("failed")
      expect(failed.statusReason).toContain("Boss session")
    })
  })

  test("atomically restores a missing active Boss binding and its frozen control profile", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({ controlProfile: "autonomous" })
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: "cht_restore_boss_binding", version: 1 },
        title: "Restore Boss binding",
        bossSessionID: boss.id,
        bossControlProfile: "guarded",
        bossPreviousControlProfile: "autonomous",
        seats: [],
        maxModelCalls: 0,
      })

      await WorkflowRunRecovery.reconcile(scopeID)

      const restored = await Session.get(boss.id)
      expect(restored.workflowRun).toEqual({ runID: run.id, role: "boss" })
      expect(await Session.resolveSessionControlProfile(boss.id)).toBe("guarded")
    })
  })

  test("clears workflow bindings that reference a run missing after restart", async () => {
    await withScope(async () => {
      const orphanBoss = await Session.create({})
      const orphanSeat = await Session.create({})
      await Session.update(orphanBoss.id, (draft) => {
        draft.workflowRun = { runID: "wfr_missing_after_claim", role: "boss" }
      })
      await Session.update(orphanSeat.id, (draft) => {
        draft.workflowRun = { runID: "wfr_missing_after_claim", role: "seat", seat: "worker", instance: 0 }
      })

      await WorkflowRunRecovery.reconcile(ScopeContext.current.scope.id)

      expect((await Session.get(orphanBoss.id)).workflowRun).toBeUndefined()
      expect((await Session.get(orphanSeat.id)).workflowRun).toBeUndefined()
    })
  })

  test("clears a terminal run's stale Boss binding without touching another run claim", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const terminalBoss = await Session.create({ controlProfile: "autonomous" })
      const otherBoss = await Session.create({})
      const terminal = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: "cht_terminal_binding", version: 1 },
        title: "Terminal binding",
        bossSessionID: terminalBoss.id,
        bossControlProfile: "guarded",
        bossPreviousControlProfile: "autonomous",
        seats: [],
        maxModelCalls: 0,
      })
      const other = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: "cht_other_binding", version: 1 },
        title: "Other binding",
        bossSessionID: otherBoss.id,
        seats: [],
        maxModelCalls: 0,
      })
      await WorkflowRunStore.update(scopeID, other.id, (draft) => {
        draft.status = "paused"
      })
      await WorkflowRunStore.update(scopeID, terminal.id, (draft) => {
        draft.status = "cancelled"
        draft.time.completed = Date.now()
      })
      await Session.update(terminalBoss.id, (draft) => {
        draft.workflowRun = { runID: terminal.id, role: "boss" }
        draft.controlProfile = "guarded"
      })
      await Session.update(otherBoss.id, (draft) => {
        draft.workflowRun = { runID: other.id, role: "boss" }
      })

      await WorkflowRunRecovery.reconcile(scopeID)

      expect((await Session.get(terminalBoss.id)).workflowRun).toBeUndefined()
      expect(await Session.resolveSessionControlProfile(terminalBoss.id)).toBe("autonomous")
      expect((await Session.get(otherBoss.id)).workflowRun).toEqual({ runID: other.id, role: "boss" })
    })
  })

  test("releases a stale seat binding when the entity lease points at another seat", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({})
      const oldSeat = await Session.create({})
      const targetSeat = await Session.create({})
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: "cht_seat_recovery", version: 1 },
        title: "Seat recovery",
        bossSessionID: boss.id,
        seats: [
          {
            seat: "executor",
            instance: 0,
            sessionID: oldSeat.id,
            entityID: "wfe_reassigned",
            status: "working",
            lastEntityIDs: [],
          },
          {
            seat: "reviewer",
            instance: 0,
            sessionID: targetSeat.id,
            entityID: "wfe_reassigned",
            status: "working",
            lastEntityIDs: [],
          },
        ],
        maxModelCalls: 0,
      })
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: run.id, role: "boss" }
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_reassigned",
          runID: run.id,
          title: "Reassigned entity",
          state: "reviewing",
          bindings: { seatSessionID: targetSeat.id },
          submissions: [],
          assignedSeat: { seat: "reviewer", instance: 0 },
          time: { created: now, updated: now, stateEntered: now },
        })
      })

      await WorkflowRunRecovery.reconcile(scopeID)

      const recovered = await WorkflowRunStore.get(scopeID, run.id)
      expect(recovered.seats[0]).toMatchObject({
        seat: "executor",
        instance: 0,
        sessionID: oldSeat.id,
        status: "idle",
      })
      expect(recovered.seats[0]?.entityID).toBeUndefined()
      expect(recovered.seats[1]?.entityID).toBe("wfe_reassigned")
      expect(recovered.entities[0]?.assignedSeat).toEqual({ seat: "reviewer", instance: 0 })
    })
  })

  test("schedules a runnable task left in an active assigned seat inbox", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({})
      const seat = await Session.create({})
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: "cht_wake_recovery", version: 1 },
        title: "Wake recovery",
        bossSessionID: boss.id,
        seats: [
          {
            seat: "worker",
            instance: 0,
            sessionID: seat.id,
            entityID: "wfe_wake",
            status: "working",
            lastEntityIDs: [],
          },
        ],
        maxModelCalls: 0,
      })
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: run.id, role: "boss" }
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: "wfe_wake",
          runID: run.id,
          title: "Wake entity",
          state: "working",
          bindings: { seatSessionID: seat.id },
          submissions: [],
          assignedSeat: { seat: "worker", instance: 0 },
          time: { created: now, updated: now, stateEntered: now },
        })
      })
      await SessionInbox.deliver({
        sessionID: seat.id,
        mode: "task",
        message: { role: "user", parts: [{ type: "text", text: "Resume this handoff" }] },
      })
      const originalScheduleWake = SessionManager.scheduleWake
      const wake = mock((_sessionID: string, _reason: string) => undefined)
      ;(SessionManager as unknown as { scheduleWake: typeof SessionManager.scheduleWake }).scheduleWake = wake

      try {
        await WorkflowRunRecovery.reconcile(scopeID)
      } finally {
        ;(SessionManager as unknown as { scheduleWake: typeof SessionManager.scheduleWake }).scheduleWake =
          originalScheduleWake
      }

      expect(wake).toHaveBeenCalledWith(seat.id, "workflow_recovery")
    })
  })
})
