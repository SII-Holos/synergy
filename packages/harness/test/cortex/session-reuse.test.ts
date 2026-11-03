import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Cortex } from "../../src/cortex"
import { CortexTypes } from "../../src/cortex/types"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { BusyError } from "../../src/session/error"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"

function createReuseRuntime() {
  return testRuntime({ register: registerCortexSessionRuntime })
}

const runtime = await createReuseRuntime()

describe("Cortex session reuse", () => {
  beforeEach(() =>
    runtime.run(() => {
      Cortex.reset()
    }),
  )

  afterEach(() =>
    runtime.run(() => {
      // Clean up any lingering runtimes that may have been registered during launch
      // (Session.create registers a runtime, and Cortex may also do so)
    }),
  )

  describe("launch with sessionID", () => {
    test("reuses existing session when it is idle", () =>
      runtime.run(async () => {
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
      }))

    test("rejects reuse when session is busy", () =>
      runtime.run(async () => {
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
      }))

    test("rejects reuse when session parentID does not match launch parentSessionID", () =>
      runtime.run(async () => {
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
      }))

    test("rejects reuse when session does not exist", () =>
      runtime.run(async () => {
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
      }))
  })

  describe("launch without sessionID (regression)", () => {
    test("still creates new session by default", () =>
      runtime.run(async () => {
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
      }))
  })
})

test("closing the reuse fixture releases terminal task retention timers", async () => {
  const fixture = await createReuseRuntime()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const schedule = setTimeout
  const cancel = clearTimeout
  using scheduling = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(schedule, {
      apply(target, receiver, args) {
        const timer = Reflect.apply(target, receiver, args) as ReturnType<typeof setTimeout>
        if (args[1] === 30_000 || args[1] === 300_000) timers.add(timer)
        return timer
      },
    }),
  )
  using cancelling = spyOn(globalThis, "clearTimeout").mockImplementation(
    new Proxy(cancel, {
      apply(target, receiver, args) {
        timers.delete(args[0])
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  try {
    await fixture.run(async () => {
      await using temporary = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await temporary.scope(),
        fn: async () => {
          const parent = await Session.create({})
          const task = await Cortex.prepare({
            description: "Retained reuse task",
            prompt: "Keep the result available",
            agent: "developer",
            parentSessionID: parent.id,
            parentMessageID: "msg_reuse_retention",
            notifyParentOnComplete: false,
          })
          await Cortex.cancel(task.id)
          expect(Cortex.get(task.id)?.status).toBe("cancelled")
        },
      })
    })
    expect(timers.size).toBe(2)
    await fixture.close()
    expect(timers.size).toBe(0)
  } finally {
    await fixture.close()
    for (const timer of timers) cancel(timer)
  }
})

afterRuntimeTests(() => runtime.close())
