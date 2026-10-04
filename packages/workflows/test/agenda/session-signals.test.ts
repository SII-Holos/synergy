import { expect, spyOn, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { AgendaStore } from "../../src/agenda/store"
import { buildAgendaReminder } from "../../src/agenda/session-signals"
import { testRuntime } from "../support/runtime"

test("pending wake reminders retain stable deadlines and withdraw when no longer pending", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({})
        const start = Date.now()
        using clock = spyOn(Date, "now").mockReturnValue(start)
        const at = start + 120_000
        const item = await AgendaStore.create({
          title: "Check progress",
          prompt: "Check the task",
          createdBy: "agent",
          sessionID: session.id,
          triggers: [{ type: "at", at }],
          wake: true,
        })
        const first = await buildAgendaReminder(session.id, session.scope.id)
        expect(first).toContain(item.id)
        for (const elapsed of [1_000, 61_000, 119_000]) {
          clock.mockReturnValue(start + elapsed)
          expect(await buildAgendaReminder(session.id, session.scope.id)).toBe(first)
        }
        expect(first).toContain(new Date(at).toISOString())
        expect(await buildAgendaReminder("unrelated-session", session.scope.id)).toBeUndefined()
        await AgendaStore.update(session.scope.id, item.id, { triggers: [{ type: "at", at: at + 60_000 }] })
        const rescheduled = await buildAgendaReminder(session.id, session.scope.id)
        expect(rescheduled).not.toBe(first)
        expect(rescheduled).toContain(new Date(at + 60_000).toISOString())
        await AgendaStore.update(session.scope.id, item.id, { wake: false })
        expect(await buildAgendaReminder(session.id, session.scope.id)).toBeUndefined()
        await AgendaStore.update(session.scope.id, item.id, { wake: true })
        expect(await buildAgendaReminder(session.id, session.scope.id)).toBe(rescheduled)
        clock.mockReturnValue(at + 60_000)
        expect(await buildAgendaReminder(session.id, session.scope.id)).toBeUndefined()
      },
    }),
  )
})
