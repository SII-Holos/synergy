import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionAbort } from "../../src/session/abort"
import { SessionEvent } from "../../src/session/event"
import { tmpdir } from "../fixture/fixture"

type AbortHook = (sessionID: string) => void | Promise<void>
type AbortHookRegistration = {
  registerHook(hook: AbortHook): () => void
}

describe("SessionAbort hooks", () => {
  test("runs registered hooks only for the explicit standard abort path", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const calls: string[] = []
        const abortHooks = SessionAbort as typeof SessionAbort & Partial<AbortHookRegistration>

        expect(typeof abortHooks.registerHook).toBe("function")
        const unregister = abortHooks.registerHook!(async (sessionID) => {
          calls.push(sessionID)
        })
        try {
          await Bus.publish(SessionEvent.Idle, { sessionID: session.id })
          await Bus.publish(SessionEvent.Completion, { sessionID: session.id, unreadCount: 1 })
          expect(calls).toEqual([])

          await SessionAbort.abort(session.id)
          expect(calls).toEqual([session.id])
        } finally {
          unregister()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("unregistered hooks do not run", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const calls: string[] = []
        const abortHooks = SessionAbort as typeof SessionAbort & Partial<AbortHookRegistration>

        expect(typeof abortHooks.registerHook).toBe("function")
        const unregister = abortHooks.registerHook!((sessionID) => {
          calls.push(sessionID)
        })
        unregister()

        await SessionAbort.abort(session.id)
        expect(calls).toEqual([])
        await Session.remove(session.id)
      },
    })
  })
})
