import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { createLocalClient } from "../src/client"
import { registerLocalRuntime } from "../src/register"

test("in-process client creates and lists sessions in its explicit Scope", async () => {
  registerLocalRuntime()
  await using directory = await tmpdir({ git: true })
  const scope = await directory.scope()
  await ScopeRuntime.ensure(scope)
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const client = createLocalClient()
      const { data: session } = await client.session.create({
        title: "Research session",
        workspace: { mode: "current" },
      })
      try {
        expect(session.scope.id).toBe(scope.id)
        expect(session.title).toBe("Research session")
        expect((await client.scope.current()).data.id).toBe(scope.id)
        expect((await client.session.list()).data.data.some((item) => item.id === session.id)).toBe(true)
      } finally {
        await Session.remove(session.id)
      }
    },
  })
  await ScopeRuntime.disposeAll()
})

test("in-process events stream existing bus events and abort closes a pending read", async () => {
  await using directory = await tmpdir()
  await ScopeContext.provide({
    scope: await directory.scope(),
    fn: async () => {
      const controller = new AbortController()
      const { stream } = await createLocalClient().event.subscribe({}, { signal: controller.signal })
      const next = stream.next()
      await Bus.publish(SessionEvent.Error, { sessionID: "ses_probe", error: { message: "probe" } })
      expect((await next).value).toEqual({
        type: "session.error",
        properties: { sessionID: "ses_probe", error: { message: "probe" } },
      })
      const pending = stream.next()
      controller.abort()
      expect((await pending).done).toBe(true)
    },
  })
  await ScopeRuntime.disposeAll()
})
