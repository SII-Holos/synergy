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
        expect(item.messageID).toBeUndefined()
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
        expect(guided.messageID).toBeUndefined()
        expect(items).toHaveLength(1)
        expect(items[0].id).toBe(queued.id)
        expect(items[0].kind).toBe("guiding")
        expect(items[0].messageID).toBeUndefined()

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

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("deliver can wake an idle session without waiting for processing to finish", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let finished = false

        const cleanup = SessionManager.onMailboxReady(async (sessionID) => {
          started.resolve()
          await release.promise
          SessionManager.drainMails(sessionID, "user")
          finished = true
        })

        try {
          const result = await Promise.race([
            SessionManager.deliver({
              target: session.id,
              waitForProcessing: false,
              mail: {
                type: "user",
                agent: "synergy",
                model: { providerID: "test", modelID: "test-model" },
                parts: [
                  {
                    id: "prt_async_agent_update",
                    sessionID: session.id,
                    messageID: "msg_async_agent_update",
                    type: "text",
                    text: "continue in the background",
                  },
                ],
              },
            }).then(() => "delivered" as const),
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
          ])

          expect(result).toBe("delivered")
          expect(finished).toBe(false)
          await started.promise
          release.resolve()
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(finished).toBe(true)
        } finally {
          release.resolve()
          cleanup()
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })
})

describe("inbox peek / commit", () => {
  test("peekReady returns queued items without deleting them", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "first" }],
        })
        await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "second" }],
        })

        // First peek — should return both items
        const firstPeek = await SessionInbox.peekReady(session.id)
        expect(firstPeek).toHaveLength(2)

        // Items should still be in the inbox (peek is non-destructive)
        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(2)

        // Second peek should return the same items
        const secondPeek = await SessionInbox.peekReady(session.id)
        expect(secondPeek).toHaveLength(2)
        expect(secondPeek.map((i) => i.id).sort()).toEqual(firstPeek.map((i) => i.id).sort())

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("commitReady deletes specified items and leaves others intact", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        const first = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "keep" }],
        })
        const second = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "delete" }],
        })

        await SessionInbox.commitReady(session.id, [second.id])

        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)
        expect(items[0].id).toBe(first.id)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("peek-then-commit pattern preserves items when commit is skipped", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "do not lose me" }],
        })

        // Peek — but simulate processing failure: never call commit
        const peeked = await SessionInbox.peekReady(session.id)
        expect(peeked).toHaveLength(1)
        expect(peeked[0].id).toBe(item.id)

        // Still in the inbox because commit was never called
        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)

        // Can be re-peeked (survives failed processing cycles)
        const rePeeked = await SessionInbox.peekReady(session.id)
        expect(rePeeked).toHaveLength(1)
        expect(rePeeked[0].id).toBe(item.id)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("drainReady deletes items (existing destructive behaviour)", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "gone" }],
        })

        const drained = await SessionInbox.drainReady(session.id)
        expect(drained).toHaveLength(1)

        // drainReady is destructive — items should be gone
        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(0)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("peekReady with excludeIDs skips already-committed items", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        const first = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "first" }],
        })
        const second = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "second" }],
        })

        // Committed items excluded, still-queued returned
        const peeked = await SessionInbox.peekReady(session.id, new Set([first.id]))
        expect(peeked).toHaveLength(1)
        expect(peeked[0].id).toBe(second.id)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})
