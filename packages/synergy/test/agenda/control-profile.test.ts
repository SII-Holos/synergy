import { afterEach, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { AgendaStore } from "../../src/agenda/store"
import { AgendaReactor } from "../../src/agenda/reactor"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"

const originalInvoke = SessionInvoke.invoke

afterEach(() => {
  ;(SessionInvoke.invoke as any) = originalInvoke
})

describe("agenda controlProfile", () => {
  test("persists controlProfile on create and update", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const item = await AgendaStore.create({
          title: "Daily full access agent",
          prompt: "Run the daily task.",
          controlProfile: "full_access",
          triggers: [{ type: "every", interval: "1d" }],
          createdBy: "agent",
        })

        expect(item.controlProfile).toBe("full_access")

        const updated = await AgendaStore.update(ScopeContext.current.scope.id, item.id, {
          controlProfile: "autonomous",
        })

        expect(updated.controlProfile).toBe("autonomous")

        const stored = await AgendaStore.get(ScopeContext.current.scope.id, item.id)
        expect(stored.controlProfile).toBe("autonomous")

        await AgendaStore.remove(ScopeContext.current.scope.id, item.id)
      },
    })
  })

  test("passes agenda item controlProfile to execution sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        ;(SessionInvoke.invoke as any) = mock(async () => {})

        const item = await AgendaStore.create({
          title: "Daily full access agent",
          prompt: "Run the daily task.",
          controlProfile: "full_access",
          triggers: [{ type: "at", at: Date.now() + 60_000 }],
          createdBy: "agent",
        })

        const result = await AgendaReactor.execute(
          { type: "manual", source: item.id, timestamp: Date.now() },
          ScopeContext.current.scope.id,
        )

        expect(result.sessionID).toBeDefined()
        expect(await Session.resolveSessionControlProfile(result.sessionID!)).toBe("full_access")

        await AgendaStore.remove(ScopeContext.current.scope.id, item.id)
        await Session.remove(result.sessionID!)
      },
    })
  })
})
