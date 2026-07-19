import { describe, expect, spyOn, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionWorkflowService } from "../../src/session/workflow"
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
      await SessionWorkflowService.enableLightloop(session.id, "Original task")
      const app = Server.App()

      const updatedResponse = await app.request(`/workflow/session/${session.id}/lightloop`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ taskDescription: "Revised task" }),
      })
      const updatedResponseBody = await updatedResponse.clone().text()
      expect(updatedResponse.status, updatedResponseBody).toBe(200)
      const updated = await updatedResponse.json()
      expect(updated.workflow).toEqual({ kind: "lightloop", taskDescription: "Revised task" })

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
      await SessionWorkflowService.enableLightloop(session.id, "Original task")
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

  test("rejects empty task descriptions", async () => {
    await withScope(async (scope) => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLightloop(session.id, "Original task")

      const response = await Server.App().request(`/workflow/session/${session.id}/lightloop`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-synergy-scope-id": scope.id },
        body: JSON.stringify({ taskDescription: " " }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: "taskDescription is required when updating Light Loop.",
      })
    })
  })
})
