import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEvent } from "../../src/session/event"

describe("session.updated nav entry payload", () => {
  test("publishes the authoritative nav entry when a session is created", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const resolved = Promise.withResolvers<{
          info: Session.Info
          navEntry?: { id: string; lastActivityAt: number }
        }>()
        const unsub = Bus.subscribe(SessionEvent.Updated, (event) => {
          resolved.resolve(
            event.properties as { info: Session.Info; navEntry?: { id: string; lastActivityAt: number } },
          )
        })

        const session = await Session.create({ title: "New project session" })
        const received = await resolved.promise
        unsub()

        expect(received.info.id).toBe(session.id)
        expect(received.navEntry?.id).toBe(session.id)
        expect(received.navEntry?.lastActivityAt).toBe(session.time.updated)

        await Session.remove(session.id)
      },
    })
  })

  test("publishes stable authoritative nav activity during a running session update", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Running" })
        const started = await Session.update(session.id, (draft) => {
          draft.pendingReply = true
          draft.title = "Running started"
        })

        const resolved = Promise.withResolvers<{
          info: Session.Info
          navEntry?: { id: string; lastActivityAt: number }
        }>()
        const unsub = Bus.subscribe(SessionEvent.Updated, (event) => {
          if (event.properties.info.id === session.id) {
            resolved.resolve(
              event.properties as { info: Session.Info; navEntry?: { id: string; lastActivityAt: number } },
            )
          }
        })

        const updated = await Session.update(session.id, (draft) => {
          draft.title = "Running still"
        })
        const received = await resolved.promise
        unsub()

        expect(updated.time.updated).toBeGreaterThan(started.time.updated)
        expect(received.info.title).toBe("Running still")
        expect(received.navEntry?.id).toBe(session.id)
        expect(received.navEntry?.lastActivityAt).toBe(started.time.updated)

        await Session.remove(session.id)
      },
    })
  })
})
