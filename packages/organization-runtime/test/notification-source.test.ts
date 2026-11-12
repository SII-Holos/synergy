import { expect, test } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerSessionSchema } from "../src/session-schema"

test("an installed organization schema contributes only its original binding to a real completion event", async () => {
  const binding = {
    schemaVersion: 1 as const,
    orgID: "org-a",
    projectID: "project-a",
    creatorID: "account-a",
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  }
  await using runtime = await testRuntime({ register: () => registerSessionSchema({ orgID: binding.orgID }) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: binding.projectID,
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({
          organization: binding,
          workspaceID: null,
          title: "Private source title",
        })
        const notices: unknown[] = []
        const unsubscribe = Bus.subscribe(SessionEvent.Completion, (event) => notices.push(event.properties.source))
        try {
          await Session.recordCompletionNotice(session.id)
          const captured = SessionSchemaRegistry.NotificationSource.parse(notices[0])
          expect(captured).toEqual({
            scopeID: binding.projectID,
            sessionID: session.id,
            references: { "organization-runtime": { version: 1, fields: binding } },
          })
          binding.bindingEpoch = 2
          expect(captured.references["organization-runtime"]?.fields.bindingEpoch).toBe(1)
          expect(JSON.stringify(captured)).not.toContain(session.title)
          expect((await Session.get(session.id)).organization?.bindingEpoch).toBe(1)
        } finally {
          unsubscribe()
        }
      },
    })
  })
})
