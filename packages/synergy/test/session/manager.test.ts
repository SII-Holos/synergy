import { describe, expect, test, mock } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { SessionManager } from "../../src/session/manager"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { SessionDrive } from "../../src/session/drive"
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
        const lease = SessionManager.acquire(childSessionID)
        expect(lease).toBeDefined()
        child.waiters = [{ onComplete: () => {}, onCancel: () => {} }]

        const stats = SessionManager.runtimeStats()
        expect(stats.totalCount).toBe(before.totalCount + 2)
        expect(stats.runningCount).toBe(before.runningCount + 1)
        expect(stats.idleCount).toBe(before.idleCount + 1)
        expect(stats.childCount).toBe(before.childCount + 1)
        expect(stats.userCount).toBe(before.userCount + 1)
        expect(stats.waiterCount).toBe(before.waiterCount + 1)
      } finally {
        SessionManager.signalAbort(childSessionID)
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
            const lease = SessionManager.acquire(session.id)
            expect(lease).toBeDefined()
            await Session.update(session.id, (draft) => {
              draft.pendingReply = true
            })
            expect(updated.at(-1)?.working?.status).toBe("busy")

            await SessionManager.release(lease!)

            expect(updated.at(-1)?.working).toBeUndefined()
          } finally {
            unsub()
            SessionManager.unregisterRuntime(session.id)
          }
        },
      })
    })

    test("release schedules persisted inbox work after the active turn", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { SessionInvoke } = await import("../../src/session/invoke")
          const originalLoop = SessionInvoke.loop
          const wakes: string[] = []
          let parentSessionID = ""
          let parentLease: SessionManager.LoopLease | undefined
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
            parentLease = SessionManager.acquire(parentSession.id)
            expect(parentLease).toBeDefined()

            await SessionInbox.deliverUnique({
              sessionID: parentSession.id,
              deliveryKey: "cortex:taskNotification:ctx_release_test",
              mode: "steer",
              message: {
                role: "user",
                metadata: { source: "cortex" },
                parts: [{ type: "text", text: "Cortex task completed" }],
              },
            })

            expect(SessionManager.isRunning(parentSession.id)).toBe(true)
            expect(await SessionInbox.list(parentSession.id)).toHaveLength(1)
            expect(wakes).toHaveLength(0)

            await SessionManager.release(parentLease!)
            parentLease = undefined
            for (let i = 0; i < 20 && wakes.length === 0; i++) await Bun.sleep(5)

            expect(wakes).toEqual([parentSession.id])
          } finally {
            if (parentLease) await SessionManager.release(parentLease)
            ;(SessionInvoke.loop as any) = originalLoop
            if (parentSessionID) SessionManager.unregisterRuntime(parentSessionID)
            SessionDrive.reset()
          }
        },
      })
    })

    test("wait-for-processing wake can release without reentrant drive deadlock", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { SessionInvoke } = await import("../../src/session/invoke")
          const originalLoop = SessionInvoke.loop
          let sessionID = ""
          let loopCount = 0
          ;(SessionInvoke.loop as any) = mock(async (wokenSessionID: string) => {
            loopCount++
            const lease = SessionManager.acquire(wokenSessionID)
            expect(lease).toBeDefined()
            expect(SessionManager.activate(lease!)).toBe(true)
            await SessionInbox.drainReady(wokenSessionID)
            await SessionManager.release(lease!)
          })

          try {
            const session = await Session.create({})
            sessionID = session.id
            await SessionInbox.deliverUnique({
              sessionID,
              deliveryKey: "agenda:reentrant-test:once:0",
              mode: "task",
              message: {
                role: "user",
                metadata: { source: "agenda" },
                parts: [{ type: "text", text: "Agenda task ready" }],
              },
            })

            const handled = await Promise.race([
              SessionDrive.request(sessionID, "reentrant-test", { waitForProcessing: true }),
              Bun.sleep(1_000).then(() => {
                throw new Error("Reentrant session drive did not settle")
              }),
            ])

            expect(handled).toBe(true)
            expect(loopCount).toBe(1)
            expect(await SessionInbox.list(sessionID)).toHaveLength(0)
            expect(SessionManager.isRunning(sessionID)).toBe(false)
          } finally {
            ;(SessionInvoke.loop as any) = originalLoop
            if (sessionID) SessionManager.unregisterRuntime(sessionID)
            SessionDrive.reset()
          }
        },
      })
    })
  })
})

describe("loop ownership", () => {
  test("reserves ownership before async session setup can yield", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        let observedSignal: AbortSignal | undefined
        const run = SessionManager.run(session.id, async (lease) => {
          observedSignal = lease.signal
        })

        expect(SessionManager.isRunning(session.id)).toBe(true)
        expect(SessionManager.getRuntime(session.id)?.owner?.phase).toBe("starting")
        expect(SessionManager.signalAbort(session.id)).toBe("signaled")
        expect(SessionManager.isRunning(session.id)).toBe(true)
        expect(SessionManager.getRuntime(session.id)?.owner?.phase).toBe("stopping")

        await run

        expect(observedSignal?.aborted).toBe(true)
        expect(SessionManager.isRunning(session.id)).toBe(false)
      },
    })
  })

  test("keeps the stopping owner exclusive until release", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        expect(SessionManager.activate(lease!)).toBe(true)
        expect(SessionManager.getRuntime(session.id)?.owner?.phase).toBe("running")

        expect(SessionManager.signalAbort(session.id)).toBe("signaled")
        expect(lease!.signal.aborted).toBe(true)
        expect(SessionManager.getRuntime(session.id)?.owner?.phase).toBe("stopping")
        expect(SessionManager.acquire(session.id)).toBeUndefined()
        expect(SessionManager.isRunning(session.id)).toBe(true)

        expect(await SessionManager.release(lease!)).toBe(true)
        expect(SessionManager.isRunning(session.id)).toBe(false)
        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("ignores a stale release without aborting the replacement owner", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const first = SessionManager.acquire(session.id)
        expect(first).toBeDefined()
        expect(await SessionManager.release(first!)).toBe(true)

        const second = SessionManager.acquire(session.id)
        expect(second).toBeDefined()
        expect(second!.generation).not.toBe(first!.generation)
        expect(second!.signal.aborted).toBe(false)

        expect(await SessionManager.release(first!)).toBe(false)
        expect(second!.signal.aborted).toBe(false)
        expect(SessionManager.isRunning(session.id)).toBe(true)

        expect(await SessionManager.release(second!)).toBe(true)
        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("settles waiters once and rejects stale owner completion", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const first = SessionManager.acquire(session.id)
        expect(first).toBeDefined()
        expect(await SessionManager.release(first!)).toBe(true)

        const second = SessionManager.acquire(session.id)
        expect(second).toBeDefined()
        const runtime = SessionManager.getRuntime(session.id)!
        const onComplete = mock(() => {})
        const onCancel = mock(() => {})
        runtime.waiters.push({ onComplete, onCancel })
        const result = { info: { id: "msg_result" }, parts: [] } as any

        expect(SessionManager.completeWaiters(first!, result)).toBe(false)
        expect(onComplete).not.toHaveBeenCalled()
        expect(SessionManager.completeWaiters(second!, result)).toBe(true)
        expect(SessionManager.completeWaiters(second!, result)).toBe(true)
        expect(onComplete).toHaveBeenCalledTimes(1)
        expect(onComplete).toHaveBeenCalledWith(result)
        expect(onCancel).not.toHaveBeenCalled()
        expect(runtime.waiters).toEqual([])

        expect(await SessionManager.release(second!)).toBe(true)
        expect(onCancel).not.toHaveBeenCalled()
        SessionManager.unregisterRuntime(session.id)
      },
    })
  })
})

describe("signalAbort", () => {
  test("aborts the active owner, cancels waiters, and retains ownership", () => {
    const sessionID = "ses_signal_abort_1"
    SessionManager.unregisterRuntime(sessionID)
    const lease = SessionManager.acquire(sessionID)
    expect(lease).toBeDefined()
    const runtime = SessionManager.getRuntime(sessionID)!
    try {
      const onCancel1 = mock(() => {})
      const onCancel2 = mock(() => {})
      const onComplete = mock(() => {})
      runtime.waiters = [
        { onComplete, onCancel: onCancel1 },
        { onComplete, onCancel: onCancel2 },
      ]

      expect(SessionManager.signalAbort(sessionID)).toBe("signaled")

      expect(lease!.signal.aborted).toBe(true)
      expect(onCancel1).toHaveBeenCalledTimes(1)
      expect(onCancel2).toHaveBeenCalledTimes(1)
      expect(onComplete).not.toHaveBeenCalled()
      expect(runtime.waiters).toEqual([])
      expect(runtime.owner?.lease).toBe(lease)
      expect(runtime.owner?.phase).toBe("stopping")
      expect(SessionManager.isRunning(sessionID)).toBe(true)
    } finally {
      SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("reports repeated abort without canceling new waiters", () => {
    const sessionID = "ses_signal_abort_repeat"
    SessionManager.unregisterRuntime(sessionID)
    const lease = SessionManager.acquire(sessionID)
    expect(lease).toBeDefined()
    const runtime = SessionManager.getRuntime(sessionID)!
    try {
      expect(SessionManager.signalAbort(sessionID)).toBe("signaled")
      const onCancel = mock(() => {})
      runtime.waiters.push({ onComplete: () => {}, onCancel })

      expect(SessionManager.signalAbort(sessionID)).toBe("already_stopping")
      expect(onCancel).not.toHaveBeenCalled()
      expect(runtime.waiters).toHaveLength(1)
    } finally {
      SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("does not change the runtime status", () => {
    const sessionID = "ses_signal_abort_status"
    SessionManager.unregisterRuntime(sessionID)
    const lease = SessionManager.acquire(sessionID)
    expect(lease).toBeDefined()
    const runtime = SessionManager.getRuntime(sessionID)!
    try {
      runtime.status = { type: "busy", description: "thinking..." }

      expect(SessionManager.signalAbort(sessionID)).toBe("signaled")
      expect(runtime.status).toEqual({ type: "busy", description: "thinking..." })
    } finally {
      SessionManager.unregisterRuntime(sessionID)
    }
  })

  test("distinguishes missing and idle runtimes", () => {
    const sessionID = "ses_signal_abort_idle"
    SessionManager.unregisterRuntime(sessionID)
    expect(SessionManager.signalAbort(sessionID)).toBe("not_found")

    SessionManager.registerRuntime(sessionID)
    try {
      expect(SessionManager.signalAbort(sessionID)).toBe("idle")
    } finally {
      SessionManager.unregisterRuntime(sessionID)
    }
  })
})
