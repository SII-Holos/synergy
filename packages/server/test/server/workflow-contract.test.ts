import { expect, test } from "bun:test"
import { z } from "zod"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { Server } from "../../src/server/server"

declare module "@ericsanchezok/synergy-harness/session/workflow-kind-registry" {
  interface WorkflowKinds {
    fixture: { kind: "extension"; extension: { kind: "fixture"; payload: string } }
  }
}

test("workflow HTTP inputs contain only registered owners and dispatch to their handlers", async () => {
  let enables = 0
  await using core = await testRuntime({
    composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false })]),
  })
  await using selected = await testRuntime({
    composition: RuntimeComponents.compose([
      localRuntime({ workers: false, environment: false }),
      {
        id: "fixture",
        apiVersion: 1,
        version: "1.0.0",
        register() {
          WorkflowKindRegistry.register({
            id: "fixture",
            conflicts: [],
            managesLock: true,
            inputSchema: z.object({ kind: z.literal("fixture"), instructions: z.string() }).strict(),
            schema: z.object({
              kind: z.literal("extension"),
              extension: z.object({ kind: z.literal("fixture"), payload: z.unknown() }),
            }),
            async enable({ sessionID, args }) {
              enables++
              await Session.update(sessionID, (draft) => {
                draft.workflow = {
                  kind: "extension",
                  extension: { kind: "fixture", payload: z.string().parse(args.instructions) },
                }
              })
            },
          })
        },
      },
    ]),
  })
  await core.run(async () => {
    expect(Object.keys((await Server.openapi()).paths ?? {})).not.toContain("/workflow/session/{id}")
    expect(
      (
        await Server.App().request("/workflow/session/absent?scopeID=home", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "fixture", instructions: "first" }),
        })
      ).status,
    ).toBe(404)
  })
  await selected.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ title: "Workflow contract" })
        const request = (body: object) =>
          Server.App().request(`/workflow/session/${session.id}?scopeID=home`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        expect((await request({ kind: "plan" })).status).toBe(400)
        expect((await request({ kind: "fixture", instructions: "first" })).status).toBe(200)
        expect((await request({ kind: "fixture", instructions: "updated" })).status).toBe(200)
        expect(enables).toBe(2)
        expect((await Session.get(session.id)).workflow).toMatchObject({ extension: { payload: "updated" } })
      },
    }),
  )
})
