import { describe, expect, test } from "bun:test"
import { BlueprintLoopService, BlueprintLoopStore } from "../../src/blueprint"
import { Identifier } from "../../src/id/id"
import { LatticeStore } from "../../src/lattice/store"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionWorkflowService } from "../../src/session/workflow"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

async function bindLoop(sessionID: string, source: "user" | "lattice" = "user") {
  const loop = await BlueprintLoopStore.create({
    noteID: Identifier.ascending("note"),
    title: "Workflow Loop",
    sessionID,
    source,
  })
  await Session.update(sessionID, (draft) => {
    draft.blueprint = { loopID: loop.id }
  })
  return loop
}

describe("SessionWorkflowService", () => {
  test("keeps plan, lightloop, and lattice mutually exclusive", async () => {
    await withScope(async () => {
      const plan = await Session.create({})
      await SessionWorkflowService.enablePlan(plan.id)
      await expect(SessionWorkflowService.enableLightloop(plan.id, "continue")).rejects.toThrow("plan workflow")
      await expect(SessionWorkflowService.enableLattice(plan.id, { kind: "lattice", mode: "auto" })).rejects.toThrow(
        "plan",
      )

      const lightloop = await Session.create({})
      await SessionWorkflowService.enableLightloop(lightloop.id, "continue")
      await expect(SessionWorkflowService.enablePlan(lightloop.id)).rejects.toThrow("lightloop")

      const lattice = await Session.create({})
      await SessionWorkflowService.enableLattice(lattice.id, { kind: "lattice", mode: "auto" })
      await expect(SessionWorkflowService.enablePlan(lattice.id)).rejects.toThrow("lattice")
    })
  })

  test("rejects plan and lightloop when a BlueprintLoop is active", async () => {
    await withScope(async () => {
      const planSession = await Session.create({})
      await bindLoop(planSession.id)
      await expect(SessionWorkflowService.enablePlan(planSession.id)).rejects.toThrow("BlueprintLoop")

      const lightloopSession = await Session.create({})
      await bindLoop(lightloopSession.id)
      await expect(SessionWorkflowService.enableLightloop(lightloopSession.id, "continue")).rejects.toThrow(
        "BlueprintLoop",
      )
    })
  })

  test("rejects lattice with an active user BlueprintLoop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await bindLoop(session.id, "user")

      await expect(SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })).rejects.toThrow(
        "user BlueprintLoop",
      )
    })
  })

  test("allows lattice with an active lattice-owned BlueprintLoop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      await bindLoop(session.id, "lattice")

      const updated = await SessionWorkflowService.enableLattice(session.id, {
        kind: "lattice",
        mode: "collaborative",
      })

      expect(updated.workflow?.kind).toBe("lattice")
      if (updated.workflow?.kind !== "lattice") throw new Error("expected lattice workflow")
      expect(updated.workflow.mode).toBe("collaborative")
    })
  })

  test("disabling lattice pauses the run and clears session workflow", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const enabled = await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      expect(enabled.workflow?.kind).toBe("lattice")

      const disabled = await SessionWorkflowService.setNone(session.id)
      const run = await LatticeStore.get(ScopeContext.current.scope.id, session.id)

      expect(disabled.workflow).toBeUndefined()
      expect(run.status).toBe("paused")
      expect(run.statusReason).toBe("user_exit")
    })
  })
})

describe("BlueprintLoop workflow source gates", () => {
  test("manual loops default to user source", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const loop = await BlueprintLoopStore.create({
        noteID: "note_test",
        title: "Manual Loop",
        sessionID: session.id,
      })

      expect(loop.source).toBe("user")
    })
  })

  test("user loops clear idle Plan workflow when binding", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enablePlan(session.id)
      const loop = await BlueprintLoopStore.create({
        noteID: "note_test",
        title: "Manual Loop",
        sessionID: session.id,
      })

      await BlueprintLoopService.bindSessionToLoop(session.id, loop.id, "execution")

      const updated = await Session.get(session.id)
      expect(updated.workflow).toBeUndefined()
      expect(updated.blueprint?.loopID).toBe(loop.id)
    })
  })

  test("user loops clear idle Light Loop workflow when starting", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLightloop(session.id, "Finish this task")
      const loop = await BlueprintLoopStore.create({
        noteID: "note_test",
        title: "Manual Loop",
        sessionID: session.id,
      })

      const started = await BlueprintLoopService.start(ScopeContext.current.scope.id, loop.id)

      const updated = await Session.get(session.id)
      expect(started.status).toBe("running")
      expect(updated.workflow).toBeUndefined()
      expect(updated.blueprint?.loopID).toBe(loop.id)
    })
  })

  test("user loops cannot clear Plan workflow while session is running", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enablePlan(session.id)
      const loop = await BlueprintLoopStore.create({
        noteID: "note_test",
        title: "Manual Loop",
        sessionID: session.id,
      })
      const lease = SessionManager.acquire(session.id)
      expect(lease).toBeDefined()

      try {
        await expect(BlueprintLoopService.bindSessionToLoop(session.id, loop.id, "execution")).rejects.toThrow()
        const updated = await Session.get(session.id)
        expect(updated.workflow).toEqual({ kind: "plan" })
        expect(updated.blueprint?.loopID).toBeUndefined()
      } finally {
        await SessionManager.release(lease!)
        SessionManager.unregisterRuntime(session.id)
      }
    })
  })

  test("user loops cannot start in lattice workflow", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      const loop = await BlueprintLoopStore.create({
        noteID: "note_test",
        title: "Manual Loop",
        sessionID: session.id,
      })

      await expect(BlueprintLoopService.start(ScopeContext.current.scope.id, loop.id)).rejects.toThrow(
        "User BlueprintLoops",
      )
    })
  })

  test("lattice-owned loops cannot start outside lattice workflow", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const loop = await BlueprintLoopStore.create({
        noteID: "note_test",
        title: "Lattice Loop",
        sessionID: session.id,
        source: "lattice",
      })

      await expect(BlueprintLoopService.start(ScopeContext.current.scope.id, loop.id)).rejects.toThrow(
        "active Lattice workflow",
      )
    })
  })
})
