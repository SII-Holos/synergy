import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Cortex } from "../../src/cortex"
import { CortexTypes } from "../../src/cortex/types"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { BusyError } from "../../src/session/error"
import { tmpdir } from "../fixture/fixture"

describe("Cortex session reuse", () => {
  beforeEach(() => {
    Cortex.reset()
  })

  afterEach(() => {
    // Clean up any lingering runtimes that may have been registered during launch
    // (Session.create registers a runtime, and Cortex may also do so)
  })

  describe("launch with sessionID", () => {
    test("reuses existing session when it is idle", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})
          // Create a child session that will be reused
          const existingChild = await Session.create({ parentID: parentSession.id })

          const task = await Cortex.launch({
            description: "Reuse task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
            sessionID: existingChild.id,
          })

          expect(task).toBeDefined()
          expect(task.sessionID).toBe(existingChild.id)
          expect(task.parentSessionID).toBe(parentSession.id)

          await Cortex.cancel(task.id)
        },
      })
    })

    test("rejects reuse when session is busy", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})
          const childSession = await Session.create({ parentID: parentSession.id })

          const lease = SessionManager.acquire(childSession.id)
          expect(lease).toBeDefined()

          try {
            await expect(
              Cortex.launch({
                description: "Reuse busy",
                prompt: "Do something",
                agent: "developer",
                parentSessionID: parentSession.id,
                parentMessageID: "msg_test01234567890abc",
                sessionID: childSession.id,
              }),
            ).rejects.toThrow(BusyError)
          } finally {
            await SessionManager.release(lease!)
            SessionManager.unregisterRuntime(childSession.id)
          }
        },
      })
    })

    test("rejects reuse when session parentID does not match launch parentSessionID", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSessionA = await Session.create({})
          const parentSessionB = await Session.create({})
          // Child of parentA, should not be reusable from parentB
          const childOfA = await Session.create({ parentID: parentSessionA.id })

          await expect(
            Cortex.launch({
              description: "Wrong parent",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSessionB.id,
              parentMessageID: "msg_test01234567890abc",
              sessionID: childOfA.id,
            }),
          ).rejects.toThrow(/does not belong/)
        },
      })
    })

    test("rejects reuse when session does not exist", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          await expect(
            Cortex.launch({
              description: "Missing session",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              sessionID: "ses_nonexistent000000000000",
            }),
          ).rejects.toThrow(/not found/)
        },
      })
    })
  })

  describe("launch without sessionID (regression)", () => {
    test("still creates new session by default", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Default task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          expect(task).toBeDefined()
          // Without sessionID, it should create a new session (not match parent)
          expect(task.sessionID).not.toBe(parentSession.id)

          await Cortex.cancel(task.id)
        },
      })
    })
  })
})
