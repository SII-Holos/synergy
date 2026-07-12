import { describe, expect, test, mock } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { SessionManager } from "../../src/session/manager"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { tmpdir } from "../fixture/fixture"
import { Channel } from "../../src/channel"
import { Bus } from "../../src/bus"
import { SessionEvent } from "../../src/session/event"
Log.init({ print: false })

describe("SessionManager.getSession", () => {
  describe("by sessionID", () => {
    test("returns session info when session exists in storage", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})

          const result = await SessionManager.getSession(session.id)

          expect(result).toBeDefined()
          expect(result!.id).toBe(session.id)

          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("returns undefined for nonexistent session", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const result = await SessionManager.getSession("ses_nonexistent")
          expect(result).toBeUndefined()
        },
      })
    })
  })

  describe("by channel", () => {
    test("returns session matching channel", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const channel: Channel.Info = {
            type: "test",
            accountId: "acc-1",
            chatId: "chat-match",
          }
          const endpoint = SessionEndpoint.fromChannel(channel)
          const session = await Session.create({ endpoint })

          const result = await SessionManager.getSession(endpoint)

          expect(result).toBeDefined()
          expect(result!.id).toBe(session.id)

          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("returns undefined when no session matches channel", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const otherChannel: Channel.Info = {
            type: "test",
            accountId: "acc-other",
            chatId: "chat-other",
          }

          const result = await SessionManager.getSession(SessionEndpoint.fromChannel(otherChannel))
          expect(result).toBeUndefined()
        },
      })
    })

    test("does not return archived sessions", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const channel: Channel.Info = {
            type: "test",
            accountId: "acc-1",
            chatId: "chat-archived",
          }
          const endpoint = SessionEndpoint.fromChannel(channel)
          const session = await Session.create({ endpoint })
          await Session.update(session.id, (draft) => {
            draft.time.archived = Date.now()
          })

          const result = await SessionManager.getSession(endpoint)
          expect(result).toBeUndefined()

          SessionManager.unregisterRuntime(session.id)
        },
      })
    })
  })

  describe("runtime", () => {
    test("registerRuntime and unregisterRuntime manage runtime entries", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})

          const runtime = SessionManager.getRuntime(session.id)
          expect(runtime).toBeDefined()
          expect(runtime!.status).toEqual({ type: "idle" })

          SessionManager.unregisterRuntime(session.id)
          expect(SessionManager.getRuntime(session.id)).toBeUndefined()
        },
      })
    })

    test("listStatuses only reports in-memory runtime status", async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })
          SessionManager.unregisterRuntime(session.id)

          const statuses = await SessionManager.listStatuses(scope.id)
          expect(statuses[session.id]).toBeUndefined()
        },
      })
    })

    test("runtimeStats reports retained runtime counters", () => {
      const userSessionID = "ses_runtime_stats_user"
      const childSessionID = "ses_runtime_stats_child"
      SessionManager.unregisterRuntime(userSessionID)
      SessionManager.unregisterRuntime(childSessionID)
      const before = SessionManager.runtimeStats()
      try {
        SessionManager.registerRuntime(userSessionID)
        const child = SessionManager.registerChildRuntime(childSessionID)
        child.abort = new AbortController()
        child.waiters = [{ onComplete: () => {}, onCancel: () => {} }]

        const stats = SessionManager.runtimeStats()
        expect(stats.totalCount).toBe(before.totalCount + 2)
        expect(stats.runningCount).toBe(before.runningCount + 1)
        expect(stats.idleCount).toBe(before.idleCount + 1)
        expect(stats.childCount).toBe(before.childCount + 1)
        expect(stats.userCount).toBe(before.userCount + 1)
        expect(stats.waiterCount).toBe(before.waiterCount + 1)
      } finally {
        SessionManager.unregisterRuntime(userSessionID)
        SessionManager.unregisterRuntime(childSessionID)
      }
    })

    test("release emits updated session info after clearing working state", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const updated: Session.Info[] = []
          const unsub = Bus.subscribe(SessionEvent.Updated, (event) => {
            if (event.properties.info.id === session.id) updated.push(event.properties.info as Session.Info)
          })

          try {
            SessionManager.acquire(session.id)
            await Session.update(session.id, (draft) => {
              draft.pendingReply = true
            })
            expect(updated.at(-1)?.working?.status).toBe("busy")

            await SessionManager.release(session.id)

            expect(updated.at(-1)?.working).toBeUndefined()
          } finally {
            unsub()
            SessionManager.unregisterRuntime(session.id)
          }
        },
      })
    })

    test("release flushes deferred cortex parent notifications before scheduling wake", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { Cortex } = await import("../../src/cortex/manager")
          const { SessionInvoke } = await import("../../src/session/invoke")
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const originalDeliver = SessionManager.deliver
          const originalIsRunning = SessionManager.isRunning
          const originalLoop = SessionInvoke.loop
          const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
          const wakes: string[] = []
          let parentSessionID = ""

          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              const parentID = "msg_cortex_parent"
              const message = await Session.updateMessage({
                id: "msg_cortex_assistant",
                role: "assistant",
                parentID,
                rootID: parentID,
                mode: "test",
                agent: "developer",
                path: {
                  cwd: ScopeContext.current.directory,
                  root: ScopeContext.current.directory,
                },
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                modelID: "test-model",
                providerID: "test-provider",
                time: {
                  created: Date.now(),
                  completed: Date.now(),
                },
                sessionID: input.sessionID,
              })
              const part = await Session.updatePart({
                id: "prt_cortex_assistant",
                messageID: message.id,
                sessionID: input.sessionID,
                type: "text",
                text: "completed",
              })
              return { info: message, parts: [part] }
            },
          )
          ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
            deliveries.push(input)
            if (typeof input.target === "string") {
              await SessionInbox.enqueueMail({
                sessionID: input.target,
                mail: input.mail as any,
              })
            }
          })
          ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
            wakes.push(sessionID)
          })

          try {
            const parentSession = await Session.create({})
            parentSessionID = parentSession.id
            const rootID = "msg_parent_root"
            await Session.updateMessage({
              id: rootID,
              role: "user",
              sessionID: parentSession.id,
              time: { created: Date.now() },
              agent: "synergy",
              model: { providerID: "test-provider", modelID: "test-model" },
              isRoot: true,
              rootID,
            } as any)
            await Session.updatePart({
              id: "prt_parent_root",
              messageID: rootID,
              sessionID: parentSession.id,
              type: "text",
              text: "parent root",
            })
            SessionManager.acquire(parentSession.id)
            ;(SessionManager.isRunning as any) = mock((sessionID: string) => {
              if (sessionID !== parentSession.id) return originalIsRunning(sessionID)
              return !!SessionManager.getRuntime(sessionID)?.abort
            })

            const task = await Cortex.launch({
              description: "Flush deferred parent notification",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: rootID,
              model: { providerID: "test-provider", modelID: "test-model" },
            })

            for (let i = 0; i < 50; i++) {
              const current = Cortex.get(task.id)
              if (current?.status === "completed" || current?.status === "error") break
              await Bun.sleep(10)
            }

            expect(deliveries).toHaveLength(0)
            expect(SessionManager.isRunning(parentSession.id)).toBe(true)

            await SessionManager.release(parentSession.id)
            await Bun.sleep(20)

            expect(deliveries).toHaveLength(1)
            expect(deliveries[0].target).toBe(parentSession.id)
            expect(deliveries[0].mail.metadata?.source).toBe("cortex")
            expect(wakes).toContain(parentSession.id)
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
            ;(SessionManager.deliver as any) = originalDeliver
            ;(SessionManager.isRunning as any) = originalIsRunning
            ;(SessionInvoke.loop as any) = originalLoop
            if (parentSessionID) SessionManager.unregisterRuntime(parentSessionID)
            Cortex.reset()
          }
        },
      })
    })
  })
})

describe("signalAbort", () => {
  test("aborts the active controller and notifies all waiters", () => {
    const sessionID = "ses_signal_abort_1"
    SessionManager.unregisterRuntime(sessionID)
    const runtime = SessionManager.registerRuntime(sessionID)
    try {
      // Simulate an acquired (busy) runtime
      const controller = new AbortController()
      runtime.abort = controller
      runtime.status = { type: "busy" }

      const onCancel1 = mock(() => {})
      const onCancel2 = mock(() => {})
      const onComplete = mock(() => {})
      runtime.waiters = [
        { onComplete, onCancel: onCancel1 },
        { onComplete, onCancel: onCancel2 },
      ]
      ;(SessionManager as any).signalAbort(sessionID)

      expect(controller.signal.aborted).toBe(true)
      expect(onCancel1).toHaveBeenCalledTimes(1)
      expect(onCancel2).toHaveBeenCalledTimes(1)
      expect(onComplete).not.toHaveBeenCalled()
      expect(runtime.waiters).toEqual([])
      expect(runtime.abort).toBeUndefined()
    } finally {
      SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("does not change the runtime status", () => {
    const sessionID = "ses_signal_abort_2"
    SessionManager.unregisterRuntime(sessionID)
    const runtime = SessionManager.registerRuntime(sessionID)
    try {
      runtime.abort = new AbortController()
      runtime.status = { type: "busy", description: "thinking..." }
      ;(SessionManager as any).signalAbort(sessionID)

      // Status must remain unchanged: signalAbort only signals, it does not
      // transition the runtime to idle. This is the core invariant that prevents
      // the race condition where session.status(idle) SSE arrives before
      // message.updated(time.completed).
      expect(runtime.status).toEqual({ type: "busy", description: "thinking..." })
    } finally {
      SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("returns safely when no runtime exists", () => {
    expect(() => {
      ;(SessionManager as any).signalAbort("ses_nonexistent")
    }).not.toThrow()
  })

  test("returns safely when runtime exists but has no active abort controller", () => {
    const sessionID = "ses_signal_abort_4"
    SessionManager.unregisterRuntime(sessionID)
    SessionManager.registerRuntime(sessionID)
    try {
      // Runtime exists but is idle (abort is undefined: normal idle state
      // after a previous release, or before acquire)

      expect(() => {
        ;(SessionManager as any).signalAbort(sessionID)
      }).not.toThrow()
    } finally {
      SessionManager.unregisterRuntime(sessionID)
    }
  })
})
