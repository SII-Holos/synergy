import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Agenda } from "../../src/agenda"
import { AgendaDelivery } from "../../src/agenda/delivery"
import { AgendaReactor } from "../../src/agenda/reactor"
import { AgendaStore } from "../../src/agenda/store"
import { Cortex } from "../../src/cortex/manager"
import { Identifier } from "../../src/id/id"
import { ContinuationKernel } from "../../src/session/continuation-kernel"
import { Session } from "../../src/session"
import { SessionDrive } from "../../src/session/drive"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "test-provider", modelID: "test-model" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

let originalGetTasksForSession: typeof Cortex.getTasksForSession

beforeEach(() => {
  Cortex.reset()
  SessionDrive.reset()
  originalGetTasksForSession = Cortex.getTasksForSession
  ;(Cortex.getTasksForSession as any) = mock(() => [])
})
afterEach(() => {
  ;(Cortex.getTasksForSession as any) = originalGetTasksForSession
  Cortex.reset()
  SessionDrive.reset()
  ContinuationKernel.reset()
})

async function terminalSession() {
  const session = await Session.create({})
  const user = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: session.id,
    time: { created: Date.now() },
    agent: "synergy",
    model,
  })) as MessageV2.User
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: user.id,
    type: "text",
    text: "go",
  })
  await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: session.id,
    parentID: user.id,
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens,
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  return session
}

async function completeChildSession(sessionID: string) {
  const parentID = Identifier.ascending("message")
  const message = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    parentID,
    rootID: parentID,
    mode: "developer",
    agent: "developer",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens,
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  const part = await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: message.id,
    type: "text",
    text: "completed",
  })
  return { info: message, parts: [part] }
}

describe("ContinuationKernel arbitration", () => {
  test("higher-priority policy consumes the idle; lower one is not consulted", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        const calls: string[] = []
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "low",
          priority: 10,
          async handle() {
            calls.push("low")
            return { kind: "handled" }
          },
        })
        ContinuationKernel.register({
          id: "high",
          priority: 100,
          async handle() {
            calls.push("high")
            return { kind: "handled" }
          },
        })

        const handled = await ContinuationKernel.evaluate(session.id)
        expect(handled).toBe(true)
        expect(calls).toEqual(["high"])
      },
    })
  }, 15_000)

  test("declining policy falls through to the next", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        const calls: string[] = []
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "high",
          priority: 100,
          async handle() {
            calls.push("high")
            return undefined
          },
        })
        ContinuationKernel.register({
          id: "low",
          priority: 10,
          async handle() {
            calls.push("low")
            return { kind: "handled" }
          },
        })
        const handled = await ContinuationKernel.evaluate(session.id)
        expect(handled).toBe(true)
        expect(calls).toEqual(["high", "low"])
      },
    })
  }, 15_000)

  test("same terminal assistant is not delivered twice for the same policy", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        let count = 0
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "once",
          priority: 50,
          async handle() {
            count++
            return { kind: "handled" }
          },
        })
        expect(await ContinuationKernel.evaluate(session.id)).toBe(true)
        expect(await ContinuationKernel.evaluate(session.id)).toBe(false)
        expect(count).toBe(1)
      },
    })
  }, 15_000)

  test("no continuation while Cortex work is active", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        ;(Cortex.getTasksForSession as any) = mock(() => [{ status: "running" }])
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "p",
          priority: 50,
          async handle() {
            return { kind: "handled" }
          },
        })
        expect(await ContinuationKernel.evaluate(session.id)).toBe(false)
      },
    })
  }, 15_000)
  test("resumes LightLoop when the last silent Cortex task becomes terminal", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalInvokeInternal = SessionInvoke.invokeInternal
        const originalLoop = SessionInvoke.loop
        const childMayFinish = Promise.withResolvers<void>()
        const parentWoke = Promise.withResolvers<void>()
        let parentSessionID = ""

        ;(Cortex.getTasksForSession as any) = originalGetTasksForSession
        ;(SessionInvoke.invokeInternal as any) = mock(
          async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
            await childMayFinish.promise
            return completeChildSession(input.sessionID)
          },
        )
        ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
          if (sessionID === parentSessionID) parentWoke.resolve()
        })

        try {
          const session = await terminalSession()
          parentSessionID = session.id
          await Session.update(session.id, (draft) => {
            draft.workflow = { kind: "lightloop", instructions: "Finish the task" }
          })
          await Cortex.launch({
            description: "Silent delegated work",
            prompt: "Finish delegated work",
            agent: "developer",
            parentSessionID: session.id,
            parentMessageID: "msg_test01234567890abc",
            model,
            visibility: "hidden",
            notifyParentOnComplete: false,
          })

          expect(await ContinuationKernel.evaluate(session.id)).toBe(false)

          childMayFinish.resolve()
          const continuation = await Promise.race([
            (async () => {
              for (let attempt = 0; attempt < 100; attempt++) {
                const item = (await SessionInbox.list(session.id)).find(
                  (candidate) => candidate.message?.metadata?.source === "light_loop_continuation",
                )
                if (item) return item
                await Bun.sleep(10)
              }
              return undefined
            })(),
            Bun.sleep(2_000).then(() => undefined),
          ])

          expect(continuation?.message?.summary?.title).toBe("Continue light loop")
          expect((await SessionInbox.list(session.id)).some((item) => item.source.type === "cortex")).toBe(false)
          await Promise.race([
            parentWoke.promise,
            Bun.sleep(2_000).then(() => {
              throw new Error("Parent session was not woken for LightLoop continuation")
            }),
          ])
        } finally {
          childMayFinish.resolve()
          ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          ;(SessionInvoke.loop as any) = originalLoop
          if (parentSessionID) SessionManager.unregisterRuntime(parentSessionID)
        }
      },
    })
  }, 15_000)
  test("ordinary Agenda schedules do not block workflow continuation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        await AgendaStore.create({
          title: "Scheduled report",
          prompt: "Prepare the report",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          createdBy: "agent",
          sessionID: session.id,
        })
        let count = 0
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "p",
          priority: 50,
          async handle() {
            count++
            return { kind: "handled" }
          },
        })

        expect(await ContinuationKernel.evaluate(session.id)).toBe(true)
        expect(count).toBe(1)
      },
    })
  }, 15_000)

  test("does not continue while an Agenda watch can wake the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        await AgendaStore.create({
          title: "Check experiment",
          prompt: "Inspect experiment progress",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          autoDone: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        let count = 0
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "p",
          priority: 50,
          async handle() {
            count++
            return { kind: "handled" }
          },
        })

        expect(await ContinuationKernel.evaluate(session.id)).toBe(false)
        expect(count).toBe(0)
      },
    })
  }, 15_000)
  test("global Agenda items also block continuation for their project session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        await AgendaStore.create({
          title: "Global experiment monitor",
          prompt: "Inspect project experiment progress",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          autoDone: true,
          global: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        let count = 0
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "p",
          priority: 50,
          async handle() {
            count++
            return { kind: "handled" }
          },
        })

        expect(await ContinuationKernel.evaluate(session.id)).toBe(false)
        expect(count).toBe(0)
      },
    })
  }, 15_000)
  test("cancelling the last wake Agenda resumes ordinary continuation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        const agenda = await Agenda.create({
          title: "Check experiment",
          prompt: "Inspect experiment progress",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          autoDone: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        let count = 0
        const resumed = Promise.withResolvers<void>()
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "p",
          priority: 50,
          async handle() {
            count++
            resumed.resolve()
            return { kind: "handled" }
          },
        })
        expect(await ContinuationKernel.evaluate(session.id)).toBe(false)

        await Agenda.cancel(agenda.id)
        await Promise.race([
          resumed.promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("continuation did not resume")), 1_000)),
        ])

        expect(count).toBe(1)
      },
    })
  }, 15_000)
  test("one-shot Agenda delivery completes before ordinary continuation resumes", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await terminalSession()
        const agenda = await AgendaStore.create({
          title: "Check completed experiment",
          prompt: "Inspect the final experiment result",
          triggers: [{ type: "at", at: Date.now() - 1_000 }],
          wake: true,
          silent: false,
          autoDone: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        const events: string[] = []
        const resumed = Promise.withResolvers<void>()
        const originalDeliver = AgendaDelivery.deliver
        ;(AgendaDelivery.deliver as any) = mock(async () => {
          events.push("delivery")
        })
        ContinuationKernel.reset()
        ContinuationKernel.register({
          id: "p",
          priority: 50,
          async handle() {
            events.push("continuation")
            resumed.resolve()
            return { kind: "handled" }
          },
        })

        try {
          expect(await ContinuationKernel.evaluate(session.id)).toBe(false)
          await AgendaReactor.execute(
            { type: "at", source: agenda.id, timestamp: Date.now() },
            ScopeContext.current.scope.id,
          )
          await Promise.race([
            resumed.promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error("continuation did not resume")), 1_000)),
          ])

          expect((await AgendaStore.get(ScopeContext.current.scope.id, agenda.id)).status).toBe("done")
          expect(events).toEqual(["delivery", "continuation"])
        } finally {
          ;(AgendaDelivery.deliver as any) = originalDeliver
        }
      },
    })
  }, 15_000)
})
