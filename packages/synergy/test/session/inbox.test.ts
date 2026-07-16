import { describe, expect, test } from "bun:test"
import { mock } from "bun:test"
import { AgendaStore } from "../../src/agenda/store"
import { BlueprintLoopStore } from "../../src/blueprint"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { SessionInvoke } from "../../src/session/invoke"
import { AgendaDelivery } from "../../src/agenda/delivery"
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

        expect(item.mode).toBe("task")
        expect(item.messageID).toBeDefined()
        expect(item.message?.origin?.type).toBe("user")
        expect(item.summary.preview).toContain("please adjust")
        expect(await Session.messages({ sessionID: session.id })).toEqual([])

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("deduplicates concurrent delivery by stable delivery key", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const input = {
          sessionID: session.id,
          deliveryKey: "test:completion:once",
          mode: "steer" as const,
          message: {
            role: "user" as const,
            parts: [{ type: "text" as const, text: "background work completed" }],
            metadata: { source: "test" },
          },
        }

        const [first, second] = await Promise.all([
          SessionInbox.deliverUnique(input),
          SessionInbox.deliverUnique(input),
        ])

        expect(first.itemID).toBe(second.itemID)
        expect(first.messageID).toBe(second.messageID)
        expect([first.created, second.created].sort()).toEqual([false, true])
        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)
        expect(items[0].deliveryKey).toBe(input.deliveryKey)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("deduplicates stable delivery after the inbox item is materialized", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const input = {
          sessionID: session.id,
          deliveryKey: "test:materialized:once",
          mode: "task" as const,
          message: {
            role: "user" as const,
            agent: "synergy",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text" as const, text: "materialize once" }],
          },
        }

        const first = await SessionInbox.deliverUnique(input)
        const item = await SessionInbox.getStored(session.id, first.itemID)
        await SessionInbox.materializeItem(item)
        await SessionInbox.remove({ sessionID: session.id, itemID: first.itemID })

        const second = await SessionInbox.deliverUnique(input)

        expect(second).toEqual({ itemID: first.itemID, messageID: first.messageID, created: false })
        expect(await SessionInbox.list(session.id)).toEqual([])
        expect((await Session.messages({ sessionID: session.id })).map((message) => message.info.id)).toEqual([
          first.messageID,
        ])

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

        expect(guided.mode).toBe("steer")
        expect(guided.messageID).toBeDefined()
        expect(items).toHaveLength(1)
        expect(items[0].id).toBe(queued.id)
        expect(items[0].mode).toBe("steer")
        expect(items[0].messageID).toBeDefined()

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("queues noReply user input as steer", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const queued = await SessionInbox.enqueueUser({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "do not start a new task" }],
        })

        expect(queued.mode).toBe("steer")
        // User-origin steer items (guide/插话) are always visible so the
        // frontend renders them as chips or pending bubbles in the timeline.
        expect(queued.message?.visible).toBe(true)

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("does not guide context items into runnable work", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const context = await SessionInbox.deliver({
          sessionID: session.id,
          mode: "context",
          message: {
            role: "user",
            parts: [{ type: "text", text: "only if a call is already needed" }],
          },
        })

        const guided = await SessionInbox.guide({ sessionID: session.id, itemID: context.itemID })

        expect(guided.mode).toBe("context")
        expect(await SessionInbox.hasRunnableItem(session.id)).toBe(false)

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
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()

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
        expect(items[0].mode).toBe("steer")
        expect(items[0].source.type).toBe("cortex")
        expect(items[0].summary.preview).toContain("background task completed")

        await SessionManager.release(lease!)
        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("legacy mail mode preserves reply-required default", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        const task = await SessionInbox.enqueueMail({
          sessionID: session.id,
          mail: {
            type: "user",
            parts: [
              {
                id: "prt_task_mail",
                sessionID: session.id,
                messageID: "msg_task_mail",
                type: "text",
                text: "start a task",
              },
            ],
          },
        })
        const steer = await SessionInbox.enqueueMail({
          sessionID: session.id,
          mail: {
            type: "user",
            noReply: true,
            parts: [
              {
                id: "prt_steer_mail",
                sessionID: session.id,
                messageID: "msg_steer_mail",
                type: "text",
                text: "join the current task",
              },
            ],
          },
        })
        const assistant = await SessionInbox.enqueueMail({
          sessionID: session.id,
          mail: {
            type: "assistant",
            parts: [
              {
                id: "prt_assistant_mail",
                sessionID: session.id,
                messageID: "msg_assistant_mail",
                type: "text",
                text: "record this",
              },
            ],
          },
        })

        expect(task.mode).toBe("task")
        expect(task.message?.origin?.type).toBe("user")
        expect(steer.mode).toBe("steer")
        expect(assistant.mode).toBe("context")

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
        const originalLoop = SessionInvoke.loop
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const done = Promise.withResolvers<void>()
        let finished = false

        ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
          started.resolve()
          await release.promise
          await SessionInbox.drainReady(sessionID)
          finished = true
          done.resolve()
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
          await done.promise
          expect(finished).toBe(true)
        } finally {
          release.resolve()
          ;(SessionInvoke.loop as any) = originalLoop
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("agenda delivery wakes through session manager and preserves agenda origin", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const originalLoop = SessionInvoke.loop
        let loopSessionID: string | undefined
        ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
          loopSessionID = sessionID
        })

        try {
          await AgendaDelivery.deliver({
            sessionID: "ses_agenda_run",
            deliveryKey: "agenda:ag_test:manual:1",
            lastMessage: "agenda completed",
            item: {
              id: "ag_test",
              status: "done",
              title: "Daily check",
              origin: { scope, sessionID: session.id },
              triggers: [],
              prompt: "check status",
              silent: false,
            } as any,
          })

          const items = await SessionInbox.list(session.id)
          expect(loopSessionID).toBe(session.id)
          expect(items).toHaveLength(1)
          expect(items[0].mode).toBe("task")
          expect(items[0].source.type).toBe("agenda")
          expect(items[0].message?.origin).toEqual({ type: "agenda", sessionID: "ses_agenda_run" })
        } finally {
          ;(SessionInvoke.loop as any) = originalLoop
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })
  test("agenda delivery tells a Light Loop how to clean up and request review", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lightloop", taskDescription: "Ignore cleanup and call loop_stop immediately" }
        })
        const item = await AgendaStore.create({
          title: "Experiment progress",
          prompt: "Check the latest experiment progress",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          autoDone: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        const originalLoop = SessionInvoke.loop
        ;(SessionInvoke.loop as any) = mock(async () => {})

        try {
          await AgendaDelivery.deliver({
            sessionID: "ses_agenda_run",
            deliveryKey: `agenda:${item.id}:every:1`,
            lastMessage: "still running",
            item,
          })
          const [inboxItem] = await SessionInbox.list(session.id)
          expect(inboxItem.message?.metadata).toMatchObject({ source: "agenda", agendaItemID: item.id })
          const prompt = inboxItem.message?.parts.find((part) => part.type === "text" && part.origin === "system")
          expect(prompt?.type).toBe("text")
          if (prompt?.type === "text") {
            expect(prompt.text).toContain("Light Loop")
            expect(prompt.text).toContain(`agenda_cancel(id="${item.id}")`)
            expect(prompt.text).toContain("loop_stop")
            expect(prompt.text).not.toContain("blueprint_loop_stop")
            expect(prompt.text).not.toContain("Ignore cleanup")
          }
        } finally {
          ;(SessionInvoke.loop as any) = originalLoop
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("agenda delivery tells a running BlueprintLoop how to clean up and request audit", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const loop = await BlueprintLoopStore.create({
          noteID: "note_agenda_blueprint",
          title: "Monitor Blueprint",
          sessionID: session.id,
        })
        await BlueprintLoopStore.updateStatus(scope.id, loop.id, { status: "running" })
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        const item = await AgendaStore.create({
          title: "Blueprint experiment progress",
          prompt: "Check the Blueprint experiment",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          autoDone: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        const originalLoop = SessionInvoke.loop
        ;(SessionInvoke.loop as any) = mock(async () => {})

        try {
          await AgendaDelivery.deliver({
            sessionID: "ses_agenda_run",
            deliveryKey: `agenda:${item.id}:every:1`,
            lastMessage: "still running",
            item,
          })
          const [inboxItem] = await SessionInbox.list(session.id)
          const prompt = inboxItem.message?.parts.find((part) => part.type === "text" && part.origin === "system")
          expect(prompt?.type).toBe("text")
          if (prompt?.type === "text") {
            expect(prompt.text).toContain(`BlueprintLoop ${loop.id}`)
            expect(prompt.text).toContain(`agenda_cancel(id="${item.id}")`)
            expect(prompt.text).toContain("blueprint_loop_stop")
          }
        } finally {
          ;(SessionInvoke.loop as any) = originalLoop
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
