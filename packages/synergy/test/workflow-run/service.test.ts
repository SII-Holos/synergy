import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { WorkflowRunService } from "../../src/workflow-run/service"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowError } from "../../src/workflow-run/error"
import { WorkflowSeats } from "../../src/workflow-run/seats"
import { IssueToPrCharter } from "../../src/workflow-run/builtin/issue-to-pr"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("WorkflowRunService", () => {
  test("create instantiates the built-in charter and binds the boss session", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      expect(run.status).toBe("active")
      // 3 executor + 1 reviewer + 1 tester = 5 seat instances.
      expect(run.seats).toHaveLength(5)
      expect(run.bossControlProfile).toBe("guarded")
      expect(run.bossPreviousControlProfile).toBeUndefined()
      const after = await Session.get(boss.id)
      expect(after.workflowRun).toEqual({ runID: run.id, role: "boss" })
    })
  })

  test("a boss session cannot own two runs", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      await WorkflowRunService.create({ charterID: IssueToPrCharter.CHARTER_ID, title: "A", bossSessionID: boss.id })
      try {
        await WorkflowRunService.create({
          charterID: IssueToPrCharter.CHARTER_ID,
          title: "B",
          bossSessionID: boss.id,
        })
        throw new Error("expected duplicate Boss binding to be rejected")
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowError.TransitionRejected)
        expect((error as InstanceType<typeof WorkflowError.TransitionRejected>).data.reason).toContain("already bound")
      }
    })
  })

  test("a legacy terminal run binding is atomically replaced when the same Boss starts a new run", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const first = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "A",
        bossSessionID: boss.id,
      })
      await WorkflowRunService.control(first.id, "cancel")
      expect((await Session.get(boss.id)).workflowRun).toBeUndefined()
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: first.id, role: "boss" }
        draft.controlProfile = first.bossControlProfile
      })

      const second = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "B",
        bossSessionID: boss.id,
      })

      expect(second.id).not.toBe(first.id)
      expect(second.bossControlProfile).toBe(first.bossControlProfile)
      expect(second.bossPreviousControlProfile).toBeUndefined()
      expect((await Session.get(boss.id)).workflowRun).toEqual({ runID: second.id, role: "boss" })
      expect((await WorkflowRunStore.get(scopeID, first.id)).status).toBe("cancelled")
      expect(await WorkflowRunStore.list(scopeID)).toHaveLength(2)
    })
  })

  test("a paused run binding cannot be replaced by a new run", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const first = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "A",
        bossSessionID: boss.id,
      })
      await WorkflowRunService.control(first.id, "pause")

      await expect(
        WorkflowRunService.create({
          charterID: IssueToPrCharter.CHARTER_ID,
          title: "B",
          bossSessionID: boss.id,
        }),
      ).rejects.toBeInstanceOf(WorkflowError.TransitionRejected)
      expect((await Session.get(boss.id)).workflowRun).toEqual({ runID: first.id, role: "boss" })
      expect(await WorkflowRunStore.list(scopeID)).toHaveLength(1)
    })
  })

  test("cancel restores an implicit guarded Boss profile to an unset raw profile", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      expect(await Session.resolveSessionControlProfile(boss.id)).toBeUndefined()
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Implicit profile",
        bossSessionID: boss.id,
      })

      expect(run.bossControlProfile).toBe("guarded")
      expect(run.bossPreviousControlProfile).toBeUndefined()
      expect(await Session.resolveSessionControlProfile(boss.id)).toBe("guarded")

      await WorkflowRunService.control(run.id, "cancel")

      expect((await Session.get(boss.id)).workflowRun).toBeUndefined()
      expect(await Session.resolveSessionControlProfile(boss.id)).toBeUndefined()
      expect((await Session.get(boss.id)).controlProfile).toBe("guarded")
    })
  })

  test("cancel restores an explicit Boss profile after removing the run cap", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({ controlProfile: "full_access" })
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Explicit profile",
        bossSessionID: boss.id,
      })

      expect(run.bossControlProfile).toBe("full_access")
      expect(run.bossPreviousControlProfile).toBe("full_access")

      await WorkflowRunService.control(run.id, "cancel")

      expect((await Session.get(boss.id)).workflowRun).toBeUndefined()
      expect(await Session.resolveSessionControlProfile(boss.id)).toBe("full_access")
    })
  })

  test("bound Boss and seat sessions cannot change the frozen control profile", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({ controlProfile: "guarded" })
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Frozen profile",
        bossSessionID: boss.id,
      })
      const seatSessionID = await WorkflowSeats.ensureSession(scopeID, run.id, "executor", 0)

      await expect(Session.updateControlProfile(boss.id, "full_access")).rejects.toThrow(
        "Cannot change the control profile while the session is bound to a workflow run",
      )
      await expect(Session.updateControlProfile(seatSessionID, "full_access")).rejects.toThrow(
        "Cannot change the control profile while the session is bound to a workflow run",
      )
      expect(await Session.resolveControlProfile(boss.id)).toBe("guarded")
      expect(await Session.resolveControlProfile(seatSessionID)).toBe("guarded")

      await WorkflowRunService.control(run.id, "cancel")
      await Session.updateControlProfile(boss.id, "autonomous")
      expect(await Session.resolveControlProfile(boss.id)).toBe("autonomous")
    })
  })

  test("concurrent create claims a boss exactly once without orphan runs", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})

      const results = await Promise.allSettled([
        WorkflowRunService.create({ charterID: IssueToPrCharter.CHARTER_ID, title: "A", bossSessionID: boss.id }),
        WorkflowRunService.create({ charterID: IssueToPrCharter.CHARTER_ID, title: "B", bossSessionID: boss.id }),
      ])

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      const runs = await WorkflowRunStore.list(scopeID)
      expect(runs).toHaveLength(1)
      expect((await Session.get(boss.id)).workflowRun?.runID).toBe(runs[0]?.id)
    })
  })

  test("adding an entity assigns an executor seat and delivers a handoff", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })

      await WorkflowRunService.addEntity({ runID: run.id, title: "Fix bug", description: "A bug" })

      const after = await WorkflowRunStore.get(scopeID, run.id)
      const entity = after.entities[0]
      expect(entity.state).toBe("executing")
      expect(entity.assignedSeat?.seat).toBe("executor")
      expect(entity.bindings.seatSessionID).toBeDefined()

      const seat = after.seats.find(
        (item) => item.seat === entity.assignedSeat?.seat && item.instance === entity.assignedSeat?.instance,
      )
      expect(seat?.entityID).toBe(entity.id)
      expect(
        await Session.resolveEffectiveControlProfile({
          sessionID: entity.bindings.seatSessionID!,
          agentControlProfile: "full_access",
        }),
      ).toBe("guarded")
      const inbox = await SessionInbox.list(entity.bindings.seatSessionID!)
      expect(inbox).toHaveLength(1)
      expect(inbox[0]?.mode).toBe("task")
      expect(inbox[0]?.message?.metadata?.workflowRun).toMatchObject({ runID: run.id, entityID: entity.id })

      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((e) => e.kind === "seat_session_created")).toBe(true)
      expect(events.some((e) => e.kind === "seat_assigned")).toBe(true)
      const handoff = events.find((e) => e.kind === "handoff_sent")
      expect(handoff).toBeDefined()
      expect(handoff?.data).toMatchObject({ itemID: inbox[0]?.id, messageID: inbox[0]?.messageID })
    })
  })

  test("cancel clears active seat tasks and marks the run cancelled", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      await WorkflowRunService.addEntity({ runID: run.id, title: "Fix bug", description: "A bug" })
      const before = await WorkflowRunStore.get(scopeID, run.id)
      const seatSessionID = before.entities[0]?.bindings.seatSessionID
      expect(seatSessionID).toBeDefined()
      expect(before.entities[0]?.assignedSeat).toBeDefined()
      expect(before.entities[0]?.pendingHandoffID).toBeDefined()
      expect(await SessionInbox.list(seatSessionID!)).toHaveLength(1)

      const cancelled = await WorkflowRunService.control(run.id, "cancel")
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.seats.every((seat) => seat.status === "idle" || seat.status === "unbound")).toBe(true)
      expect(cancelled.seats.every((seat) => seat.entityID === undefined)).toBe(true)
      expect(cancelled.entities[0]?.assignedSeat).toBeUndefined()
      expect(cancelled.entities[0]?.bindings.seatSessionID).toBeUndefined()
      expect(cancelled.entities[0]?.pendingHandoffID).toBeUndefined()
      expect(await SessionInbox.list(seatSessionID!)).toHaveLength(0)
      expect((await Session.get(boss.id)).workflowRun).toBeUndefined()
    })
  })

  test("cancel only clears the Boss binding when it still belongs to that run", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      await Session.update(boss.id, (draft) => {
        draft.workflowRun = { runID: "wfr_new_owner", role: "boss" }
      })

      await WorkflowRunService.control(run.id, "cancel")

      expect((await Session.get(boss.id)).workflowRun).toEqual({ runID: "wfr_new_owner", role: "boss" })
    })
  })

  test("deleting a seat session atomically clears both sides of its lease", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      await WorkflowRunService.addEntity({ runID: run.id, title: "Fix bug", description: "A bug" })
      const before = await WorkflowRunStore.get(scopeID, run.id)
      const entity = before.entities[0]
      const seatSessionID = entity?.bindings.seatSessionID
      const assignedSeat = entity?.assignedSeat
      expect(seatSessionID).toBeDefined()
      expect(assignedSeat).toBeDefined()
      expect(entity?.pendingHandoffID).toBeDefined()

      await Session.remove(seatSessionID!)

      const updated = await WorkflowRunStore.get(scopeID, run.id)
      const updatedEntity = updated.entities[0]
      const updatedSeat = updated.seats.find(
        (seat) => seat.seat === assignedSeat?.seat && seat.instance === assignedSeat?.instance,
      )
      expect(updatedEntity?.state).toBe("blocked")
      expect(updatedEntity?.blockedReason).toBe("assigned seat session was deleted")
      expect(updatedEntity?.assignedSeat).toBeUndefined()
      expect(updatedEntity?.bindings.seatSessionID).toBeUndefined()
      expect(updatedEntity?.pendingHandoffID).toBeUndefined()
      expect(updatedSeat?.sessionID).toBeUndefined()
      expect(updatedSeat?.entityID).toBeUndefined()
      expect(updatedSeat?.status).toBe("unbound")
    })
  })

  test("cancel does not abort the Boss turn performing the control action", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })

      await SessionManager.run(boss.id, async (lease) => {
        const cancelled = await WorkflowRunService.control(run.id, "cancel")
        expect(cancelled.status).toBe("cancelled")
        expect(lease.signal.aborted).toBe(false)
      })
    })
  })

  test("pause halts and resume reactivates a run", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      const paused = await WorkflowRunService.control(run.id, "pause")
      expect(paused.status).toBe("paused")
      const resumed = await WorkflowRunService.control(run.id, "resume")
      expect(resumed.status).toBe("active")
      const cancelled = await WorkflowRunService.control(run.id, "cancel")
      expect(cancelled.status).toBe("cancelled")
    })
  })

  test("deleting the Boss session fences its active run", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })

      await Session.remove(boss.id)

      expect((await WorkflowRunStore.get(scopeID, run.id)).status).toBe("cancelled")
      expect((await WorkflowRunService.control(run.id, "cancel")).status).toBe("cancelled")
    })
  })
})
