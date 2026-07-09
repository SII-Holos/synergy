import { describe, expect, test, mock } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { SessionManager } from "../../src/session/manager"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
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
