import { expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionInbox } from "../../src/session/inbox"
import { SessionExecutionSource } from "../../src/session/execution-source"
import { testRuntime } from "../support/runtime"

test("host admission runs before execution and denial retains queued input without automatic wake", async () => {
  const admissions: string[] = []
  let allow = false
  let executions = 0
  await using runtime = await testRuntime({
    register: () =>
      SessionExecutionSource.register({
        async authorize(input) {
          admissions.push(input.sessionID)
          expect(input.scopeID).toBe(Scope.home().id)
          if (!allow) throw new Error("host lease unavailable")
        },
      }),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "fixture", modelID: "fixture" },
          parts: [{ type: "text", text: "accepted work" }],
        })
        await expect(SessionManager.run(session.id, async () => executions++)).rejects.toBeInstanceOf(
          SessionExecutionSource.DeniedError,
        )
        expect(executions).toBe(0)
        expect(SessionManager.isRunning(session.id)).toBe(false)
        expect(SessionManager.hasPendingWake()).toBe(false)
        expect(await SessionInbox.list(session.id)).toHaveLength(1)
        allow = true
        await SessionManager.run(session.id, async () => {
          executions++
          SessionManager.closeAdmission()
        })
        expect(executions).toBe(1)
        expect(admissions).toEqual([session.id, session.id])
        expect(() => SessionExecutionSource.register({ authorize: async () => {} })).toThrow(
          "before opening the Runtime",
        )
      },
    }),
  )
})

test("every child is admitted separately and Runtime authority is isolated", async () => {
  const admissions: Array<{ sessionID: string; parentSessionID?: string }> = []
  await using guarded = await testRuntime({
    register: () =>
      SessionExecutionSource.register({
        async authorize(input) {
          admissions.push(input)
        },
      }),
  })
  await using independent = await testRuntime()
  for (const runtime of [guarded, independent]) {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const parent = await Session.create({ workspace: null })
          const child = await Session.create({ parentID: parent.id, workspace: null })
          await SessionManager.run(parent.id, async () => {})
          await SessionManager.run(child.id, async () => {})
          if (runtime === guarded)
            expect(admissions).toEqual([
              expect.objectContaining({ sessionID: parent.id, parentSessionID: undefined }),
              expect.objectContaining({ sessionID: child.id, parentSessionID: parent.id }),
            ])
        },
      }),
    )
  }
  expect(admissions).toHaveLength(2)
})

test("automatic waking stops after authority denial and preserves accepted input", async () => {
  let admissions = 0
  await using runtime = await testRuntime({
    register: () =>
      SessionExecutionSource.register({
        async authorize() {
          admissions++
          throw new Error("host lease revoked")
        },
      }),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "fixture", modelID: "fixture" },
          parts: [{ type: "text", text: "accepted work" }],
        })
        SessionManager.scheduleWake(session.id, "fixture")
        const deadline = Date.now() + 1000
        while (SessionManager.hasPendingWake() && Date.now() < deadline) await Bun.sleep(10)
        expect(SessionManager.hasPendingWake()).toBe(false)
        expect(admissions).toBe(1)
        expect(await SessionInbox.list(session.id)).toHaveLength(1)
      },
    }),
  )
})

test("cancellation during host admission drains the claim and never enters execution", async () => {
  const entered = Promise.withResolvers<void>()
  let executions = 0
  await using runtime = await testRuntime({
    register: () =>
      SessionExecutionSource.register({
        async authorize(input) {
          entered.resolve()
          await new Promise<void>((_resolve, reject) => {
            input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true })
          })
        },
      }),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const work = SessionManager.run(session.id, async () => executions++)
        await entered.promise
        SessionManager.signalAbort(session.id)
        await expect(work).rejects.toMatchObject({ name: "AbortError" })
        expect(executions).toBe(0)
        expect(SessionManager.isRunning(session.id)).toBe(false)
        expect(SessionManager.hasPendingWake()).toBe(false)
      },
    }),
  )
})
