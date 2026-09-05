import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "../../src/blueprint"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionWorkflowService, WorkflowConflictError } from "../../src/session/workflow"
import { tmpdir } from "../fixture/fixture"
import "../../src/product-registration"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("Boss workflow", () => {
  test("enableBoss marks the session as a boss root", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const enabled = await SessionWorkflowService.enableBoss(session.id)
      expect(enabled.workflow).toEqual({ kind: "boss", role: "boss" })
      const stored = await Session.get(session.id)
      expect(stored.workflow).toEqual({ kind: "boss", role: "boss" })
    })
  })

  test("enableBoss is mutually exclusive with plan, lightloop, and lattice", async () => {
    await withScope(async () => {
      const plan = await Session.create({})
      await SessionWorkflowService.enablePlan(plan.id)
      await expect(SessionWorkflowService.enableBoss(plan.id)).rejects.toThrow("plan")

      const lightloop = await Session.create({})
      await SessionWorkflowService.startLightloop(lightloop.id, "continue")
      await expect(SessionWorkflowService.enableBoss(lightloop.id)).rejects.toThrow("lightloop")

      const lattice = await Session.create({})
      await SessionWorkflowService.enableLattice(lattice.id, { kind: "lattice", mode: "auto" })
      await expect(SessionWorkflowService.enableBoss(lattice.id)).rejects.toThrow("lattice")
    })
  })

  test("existing workflows cannot be enabled on a boss session", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableBoss(session.id)
      await expect(SessionWorkflowService.enablePlan(session.id)).rejects.toThrow("boss")
      await expect(SessionWorkflowService.startLightloop(session.id, "continue")).rejects.toThrow("boss")
      await expect(
        SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" }),
      ).rejects.toMatchObject({ data: { reason: expect.stringContaining("boss") } })
    })
  })

  test("enableBoss rejects while a BlueprintLoop is active", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const loop = await BlueprintLoopStore.create({
        noteID: Identifier.ascending("note"),
        title: "Active Loop",
        sessionID: session.id,
        source: "user",
      })
      await Session.update(session.id, (draft) => {
        draft.blueprint = { loopID: loop.id }
      })
      await expect(SessionWorkflowService.enableBoss(session.id)).rejects.toThrow("BlueprintLoop")
    })
  })

  test("enableBoss requires an idle session", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const lease = SessionManager.acquire(session.id)
      expect(lease).toBeDefined()
      try {
        await expect(SessionWorkflowService.enableBoss(session.id)).rejects.toThrow()
      } finally {
        await SessionManager.release(lease!, { requestNextWork: false })
        SessionManager.unregisterRuntime(session.id)
      }
    })
  })

  test("setNone clears only the root projection without touching children", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await Session.create({
        parentID: boss.id,
        workflow: { kind: "boss", role: "worker", workerRole: "code", rootID: boss.id },
      })
      expect(worker.workflow).toEqual({
        kind: "boss",
        role: "worker",
        workerRole: "code",
        rootID: boss.id,
      })

      const cleared = await SessionWorkflowService.setNone(boss.id)
      expect(cleared.workflow).toBeUndefined()
      const storedWorker = await Session.get(worker.id)
      expect(storedWorker.workflow).toEqual({
        kind: "boss",
        role: "worker",
        workerRole: "code",
        rootID: boss.id,
      })
    })
  })

  test("worker sessions cannot be switched to another workflow", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await SessionWorkflowService.enableBoss(boss.id)
      const worker = await Session.create({
        parentID: boss.id,
        workflow: { kind: "boss", role: "worker", workerRole: "code", rootID: boss.id },
      })
      await expect(SessionWorkflowService.enablePlan(worker.id)).rejects.toThrow(WorkflowConflictError)
      await expect(SessionWorkflowService.enableBoss(worker.id)).rejects.toThrow(WorkflowConflictError)
    })
  })
})
