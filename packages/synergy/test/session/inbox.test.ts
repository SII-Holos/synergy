import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("SessionInbox", () => {
  test("queues user input without writing a transcript message", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "please adjust the current run" }],
        })

        expect(item.kind).toBe("queued_user")
        expect(item.deliveryTarget).toBe("after_turn")
        expect(item.summary.preview).toContain("please adjust")
        expect(await Session.messages({ sessionID: session.id })).toEqual([])

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("promotes queued user input into guiding state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const queued = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "steer sooner" }],
        })

        const guided = await SessionInbox.guide({ sessionID: session.id, itemID: queued.id })
        const items = await SessionInbox.list(session.id)

        expect(guided.kind).toBe("guiding")
        expect(guided.deliveryTarget).toBe("next_model_call")
        expect(items).toHaveLength(1)
        expect(items[0].id).toBe(queued.id)
        expect(items[0].kind).toBe("guiding")

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("deliver creates a visible agent update while the session is running", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        SessionManager.acquire(session.id)

        await SessionManager.deliver({
          target: session.id,
          mail: {
            type: "user",
            agent: "synergy",
            model: { providerID: "test", modelID: "test-model" },
            metadata: { source: "cortex" },
            parts: [
              {
                id: "prt_agent_update",
                sessionID: session.id,
                messageID: "msg_agent_update",
                type: "text",
                text: "background task completed",
              },
            ],
          },
        })

        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)
        expect(items[0].kind).toBe("agent_update")
        expect(items[0].source.type).toBe("cortex")
        expect(items[0].summary.preview).toContain("background task completed")

        await SessionManager.release(session.id)
        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})
