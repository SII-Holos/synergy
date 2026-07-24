import { describe, expect, spyOn, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionWorkflowService } from "../../src/session/workflow"
import { LatticeRunService } from "../../src/lattice/run-service"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn: () => fn(scope) })
}

describe("workflow routes", () => {
  test("updates and cancels an active Light Loop", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      await SessionWorkflowService.startLightloop(session.id, "Original task")
      const app = Server.App()

      const updatedResponse = await app.request(`/workflow/session/${session.id}/lightloop`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ instructions: "Revised task" }),
      })
      const updatedResponseBody = await updatedResponse.clone().text()
      expect(updatedResponse.status, updatedResponseBody).toBe(200)
      const updated = await updatedResponse.json()
      expect(updated.workflow).toEqual({ kind: "lightloop", instructions: "Revised task" })

      const cancelledResponse = await app.request(`/workflow/session/${session.id}/lightloop/cancel`, {
        method: "POST",
        headers: { "x-synergy-scope-id": scope.id },
      })
      expect(cancelledResponse.status).toBe(200)
      const cancelled = await cancelledResponse.json()
      expect(cancelled.workflow).toBeUndefined()
    })
  })

  test("returns structured cancellation errors", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      await SessionWorkflowService.startLightloop(session.id, "Original task")
      const cancel = spyOn(SessionWorkflowService, "cancelLightloop").mockRejectedValueOnce(new Error("Cancel failed"))

      try {
        const response = await Server.App().request(`/workflow/session/${session.id}/lightloop/cancel`, {
          method: "POST",
          headers: { "x-synergy-scope-id": scope.id },
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ message: "Cancel failed" })
      } finally {
        cancel.mockRestore()
      }
    })
  })

  test("rejects empty instructions", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      await SessionWorkflowService.startLightloop(session.id, "Original task")

      const response = await Server.App().request(`/workflow/session/${session.id}/lightloop`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ instructions: " " }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: "instructions is required when updating Light Loop.",
      })
    })
  })

  test("rejects legacy Lattice actions and reports paused-run conflicts as 409", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const enabled = await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      if (enabled.workflow?.kind !== "lattice") throw new Error("expected Lattice workflow")
      await LatticeRunService.pause(enabled.workflow.runID)

      const legacy = await Server.App().request(`/workflow/session/${session.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ kind: "lattice", mode: "auto", action: "continue" }),
      })
      expect(legacy.status).toBe(400)

      const conflict = await Server.App().request(`/workflow/session/${session.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ kind: "lattice", mode: "auto" }),
      })
      expect(conflict.status).toBe(409)
    })
  })

  test("reports workflow and BlueprintLoop ownership conflicts as 409", async () => {
    await withScope(async (scope) => {
      const workflowSession = await Session.create({})
      await SessionWorkflowService.enablePlan(workflowSession.id)

      const workflowConflict = await Server.App().request(`/workflow/session/${workflowSession.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ kind: "lattice", mode: "auto" }),
      })
      expect(workflowConflict.status).toBe(409)

      const loopSession = await Session.create({})
      const loop = await BlueprintLoopStore.create({
        noteID: "note_route_conflict",
        title: "User Loop",
        sessionID: loopSession.id,
      })
      await Session.update(loopSession.id, (draft) => {
        draft.blueprint = { loopID: loop.id }
      })

      const loopConflict = await Server.App().request(`/workflow/session/${loopSession.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ kind: "lattice", mode: "auto" }),
      })
      expect(loopConflict.status).toBe(409)
    })
  })

  test("reserves 400 for validation and reports unexpected Lattice workflow failures as 500", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const set = spyOn(SessionWorkflowService, "set").mockRejectedValueOnce(new Error("sensitive storage failure"))

      try {
        const response = await Server.App().request(`/workflow/session/${session.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
          body: JSON.stringify({ kind: "lattice", mode: "auto" }),
        })

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ message: "Internal server error" })
      } finally {
        set.mockRestore()
      }
    })
  })

  test("reports a busy Session as a workflow state conflict", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      const lease = SessionManager.acquire(session.id)
      if (!lease) throw new Error("expected Session lease")

      try {
        const response = await Server.App().request(`/workflow/session/${session.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
          body: JSON.stringify({ kind: "lattice", mode: "auto" }),
        })
        expect(response.status).toBe(409)
      } finally {
        await SessionManager.release(lease, { requestNextWork: false })
        SessionManager.unregisterRuntime(session.id)
      }
    })
  })
})
