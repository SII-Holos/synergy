import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Cortex } from "../../src/cortex/manager"
import { Identifier } from "../../src/id/id"
import { ContinuationKernel } from "../../src/session/continuation-kernel"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "test-provider", modelID: "test-model" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

let originalGetTasksForSession: typeof Cortex.getTasksForSession

beforeEach(() => {
  originalGetTasksForSession = Cortex.getTasksForSession
  ;(Cortex.getTasksForSession as any) = mock(() => [])
})
afterEach(() => {
  ;(Cortex.getTasksForSession as any) = originalGetTasksForSession
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
            return true
          },
        })
        ContinuationKernel.register({
          id: "high",
          priority: 100,
          async handle() {
            calls.push("high")
            return true
          },
        })

        const handled = await ContinuationKernel.evaluate(session.id)
        expect(handled).toBe(true)
        expect(calls).toEqual(["high"])
      },
    })
  })

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
            return false
          },
        })
        ContinuationKernel.register({
          id: "low",
          priority: 10,
          async handle() {
            calls.push("low")
            return true
          },
        })
        const handled = await ContinuationKernel.evaluate(session.id)
        expect(handled).toBe(true)
        expect(calls).toEqual(["high", "low"])
      },
    })
  })

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
            return true
          },
        })
        expect(await ContinuationKernel.evaluate(session.id)).toBe(true)
        expect(await ContinuationKernel.evaluate(session.id)).toBe(false)
        expect(count).toBe(1)
      },
    })
  })

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
            return true
          },
        })
        expect(await ContinuationKernel.evaluate(session.id)).toBe(false)
      },
    })
  })
})
