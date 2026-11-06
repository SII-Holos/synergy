import { expect, test } from "bun:test"
import { SessionExecutionContributions } from "../../src/session/execution-contributions"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { testRuntime } from "../support/runtime"

test("model preparation is Runtime-owned, detached and awaited for its exact assistant", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const seen: string[] = []
  await using runtime = await testRuntime({
    register() {
      SessionExecutionContributions.register({
        id: "model-state",
        async prepareModel(session, context) {
          expect(context).toMatchObject({ messageID: "assistant-a", rootMessageID: "root-a", agent: "fixture" })
          session.time.updated = 123
          entered.resolve()
          await release.promise
          seen.push(context.messageID)
        },
      })
    },
  })
  await using independent = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const context = {
          messageID: "assistant-a",
          rootMessageID: "root-a",
          agent: "fixture",
          signal: new AbortController().signal,
        }
        const pending = SessionExecutionContributions.prepareModel(session, context)
        const settled = pending.then(() => true)
        await entered.promise
        expect(seen).toEqual([])
        await independent.run(() => SessionExecutionContributions.prepareModel(session, context))
        expect(seen).toEqual([])
        release.resolve()
        expect(await settled).toBe(true)
        expect(seen).toEqual(["assistant-a"])
        expect(session.time.updated).not.toBe(123)
        expect((await Session.get(session.id)).time.updated).not.toBe(123)
      },
    }),
  )
  expect(() => runtime.run(() => SessionExecutionContributions.register({ id: "late" }))).toThrow("before opening")
})

test("model preparation errors stop later contributions", async () => {
  const failure = new Error("Authoritative observation unavailable")
  let entered = false
  await using runtime = await testRuntime({
    register() {
      SessionExecutionContributions.register({
        id: "failure",
        prepareModel: async () => {
          throw failure
        },
      })
      SessionExecutionContributions.register({
        id: "later",
        prepareModel: async () => {
          entered = true
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await expect(
          SessionExecutionContributions.prepareModel(session, {
            messageID: "assistant",
            rootMessageID: "root",
            agent: "fixture",
            signal: new AbortController().signal,
          }),
        ).rejects.toBe(failure)
        expect(entered).toBe(false)
      },
    }),
  )
})

test("model preparation retains cancellation before and after the host callback", async () => {
  const controller = new AbortController()
  const reason = new Error("Owner canceled preparation")
  let calls = 0
  await using runtime = await testRuntime({
    register() {
      SessionExecutionContributions.register({
        id: "cancellation",
        async prepareModel(_session, context) {
          expect(context.signal).toBe(controller.signal)
          calls++
          controller.abort(reason)
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const context = { messageID: "assistant", rootMessageID: "root", agent: "fixture", signal: controller.signal }
        await expect(SessionExecutionContributions.prepareModel(session, context)).rejects.toBe(reason)
        expect(calls).toBe(1)
        await expect(SessionExecutionContributions.prepareModel(session, context)).rejects.toBe(reason)
        expect(calls).toBe(1)
      },
    }),
  )
})
