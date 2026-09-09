import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-workflows/blueprint"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { WorkflowSessionService, WorkflowConflictError } from "@ericsanchezok/synergy-workflows/session/workflow"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import "@ericsanchezok/synergy-product-runtime/product-registration"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("Boss workflow", () => {
  test("enableBoss marks the session as a boss root", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const enabled = await WorkflowSessionService.enableBoss(session.id)
      expect(enabled.workflow).toEqual({ kind: "boss", role: "boss" })
      const stored = await Session.get(session.id)
      expect(stored.workflow).toEqual({ kind: "boss", role: "boss" })
    })
  })

  test("enableBoss is mutually exclusive with plan, lightloop, and lattice", async () => {
    await withScope(async () => {
      const plan = await Session.create({})
      await WorkflowSessionService.enablePlan(plan.id)
      await expect(WorkflowSessionService.enableBoss(plan.id)).rejects.toThrow("plan")

      const lightloop = await Session.create({})
      await WorkflowSessionService.startLightloop(lightloop.id, "continue")
      await expect(WorkflowSessionService.enableBoss(lightloop.id)).rejects.toThrow("lightloop")

      const lattice = await Session.create({})
      await WorkflowSessionService.enableLattice(lattice.id, { kind: "lattice", mode: "auto" })
      await expect(WorkflowSessionService.enableBoss(lattice.id)).rejects.toThrow("lattice")
    })
  })

  test("existing workflows cannot be enabled on a boss session", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await WorkflowSessionService.enableBoss(session.id)
      await expect(WorkflowSessionService.enablePlan(session.id)).rejects.toThrow("boss")
      await expect(WorkflowSessionService.startLightloop(session.id, "continue")).rejects.toThrow("boss")
      await expect(
        WorkflowSessionService.enableLattice(session.id, { kind: "lattice", mode: "auto" }),
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
      await expect(WorkflowSessionService.enableBoss(session.id)).rejects.toThrow("BlueprintLoop")
    })
  })

  test("enableBoss requires an idle session", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const lease = SessionManager.acquire(session.id)
      expect(lease).toBeDefined()
      try {
        await expect(WorkflowSessionService.enableBoss(session.id)).rejects.toThrow()
      } finally {
        await SessionManager.release(lease!, { requestNextWork: false })
        SessionManager.unregisterRuntime(session.id)
      }
    })
  })

  test("setNone clears only the root projection without touching children", async () => {
    await withScope(async () => {
      const boss = await Session.create({})
      await WorkflowSessionService.enableBoss(boss.id)
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

      const cleared = await WorkflowSessionService.setNone(boss.id)
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
      await WorkflowSessionService.enableBoss(boss.id)
      const worker = await Session.create({
        parentID: boss.id,
        workflow: { kind: "boss", role: "worker", workerRole: "code", rootID: boss.id },
      })
      await expect(WorkflowSessionService.enablePlan(worker.id)).rejects.toThrow(WorkflowConflictError)
      await expect(WorkflowSessionService.enableBoss(worker.id)).rejects.toThrow(WorkflowConflictError)
    })
  })
})
