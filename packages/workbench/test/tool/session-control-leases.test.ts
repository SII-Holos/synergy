import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import type { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { SessionControlTool } from "@ericsanchezok/synergy-workbench/project/tools/session-control"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

function context(sessionID: string, abort = new AbortController().signal): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: "session-control-fixture",
    agent: PrimaryAgentIdentity.names.general,
    abort,
    metadata() {},
    async ask() {},
  }
}

async function withSessions(
  fn: (fixture: {
    caller: Session.Info
    target: Session.Info
    targetScope: Scope
    tool: Awaited<ReturnType<typeof SessionControlTool.init>>
  }) => Promise<void>,
) {
  await using callerDirectory = await tmpdir({ git: true })
  await using targetDirectory = await tmpdir({ git: true })
  const targetScope = await targetDirectory.scope()
  const target = await ScopeContext.provide({ scope: targetScope, fn: () => Session.create({ title: "Target" }) })
  await ScopeContext.provide({
    scope: await callerDirectory.scope(),
    fn: async () => {
      const caller = await Session.create({ title: "Caller" })
      try {
        await fn({ caller, target, targetScope, tool: await SessionControlTool.init() })
      } finally {
        await Session.remove(target.id)
        await Session.remove(caller.id)
      }
    },
  })
}

describe("session_control execution ownership", () => {
  for (const registered of [false, true]) {
    test(`abort preserves an ${registered ? "existing" : "absent"} idle runtime without an execution lease`, () =>
      runtime.run(() =>
        withSessions(async ({ caller, target, tool }) => {
          if (!registered) SessionManager.unregisterRuntime(target.id)
          const previous = registered ? SessionManager.registerRuntime(target.id) : undefined
          let idleEvents = 0
          const unsubscribe = Bus.subscribeGlobal(SessionEvent.Idle, (event) => {
            if (event.properties.sessionID === target.id) idleEvents++
          })
          try {
            const result = await tool.execute(
              tool.parameters.parse({ target: target.id, action: "abort" }),
              context(caller.id),
            )
            expect(result.metadata.action).toBe("abort")
            expect(SessionManager.getRuntime(target.id)).toBe(previous)
            expect(SessionManager.isRunning(target.id)).toBe(false)
            expect(idleEvents).toBe(0)
            expect(SessionManager.hasPendingWake()).toBe(false)
            expect((await SessionLifecycle.snapshot(target.id))?.reason).toBe("aborted")
          } finally {
            unsubscribe()
          }
        }),
      ))
  }

  test("abort signals a busy session across Scopes while retaining both original owners", () =>
    runtime.run(() =>
      withSessions(async ({ caller, target, tool }) => {
        const callerLease = SessionManager.acquire(caller.id)!
        SessionManager.activate(callerLease)
        const queued = await SessionInbox.enqueueUser({
          sessionID: target.id,
          parts: [{ type: "text", text: "Wait for an explicit continue" }],
        })
        const started = Promise.withResolvers<SessionManager.LoopLease>()
        const cleanup = Promise.withResolvers<void>()
        let idleEvents = 0
        const unsubscribe = Bus.subscribeGlobal(SessionEvent.Idle, (event) => {
          if (event.properties.sessionID === target.id) idleEvents++
        })
        const running = SessionManager.run(target.id, async (lease) => {
          started.resolve(lease)
          await cleanup.promise
        })
        try {
          const lease = await started.promise
          const result = await tool.execute(
            tool.parameters.parse({ target: target.id, action: "abort" }),
            context(caller.id, callerLease.signal),
          )
          expect(result.metadata.action).toBe("abort")
          expect(lease.signal.aborted).toBe(true)
          expect(SessionManager.getRuntime(target.id)?.owner).toMatchObject({ lease, phase: "stopping" })
          expect(SessionManager.getRuntime(target.id)?.owner?.lease).toBe(lease)
          expect(SessionManager.isRunning(target.id)).toBe(true)
          expect(SessionManager.acquire(target.id)).toBeUndefined()
          expect(SessionManager.getRuntime(caller.id)?.owner?.lease).toBe(callerLease)
          expect(callerLease.signal.aborted).toBe(false)
          expect((await SessionLifecycle.snapshot(target.id))?.reason).toBe("aborted")
          expect(await SessionLifecycle.snapshot(caller.id)).toBeUndefined()
          expect(idleEvents).toBe(0)
          await tool.execute(tool.parameters.parse({ target: target.id, action: "abort" }), context(caller.id))
          expect(SessionManager.getRuntime(target.id)?.owner?.lease).toBe(lease)
          expect(idleEvents).toBe(0)
          cleanup.resolve()
          await running
          expect(idleEvents).toBe(1)
          expect(SessionManager.isRunning(target.id)).toBe(false)
          expect((await SessionInbox.list(target.id)).map((item) => item.id)).toEqual([queued.id])
          expect(SessionManager.hasPendingWake()).toBe(false)
        } finally {
          SessionManager.signalAbort(target.id, { pauseTurn: true })
          cleanup.resolve()
          await running
          await SessionManager.finish(callerLease, { requestNextWork: false })
          unsubscribe()
        }
      }),
    ))

  test("abort can signal its own running lease without waiting for its release", () =>
    runtime.run(() =>
      withSessions(async ({ target, tool }) => {
        await SessionManager.run(target.id, async (lease) => {
          const result = await tool.execute(
            tool.parameters.parse({ target: target.id, action: "abort" }),
            context(target.id, lease.signal),
          )
          expect(result.metadata.action).toBe("abort")
          expect(lease.signal.aborted).toBe(true)
          expect(SessionManager.getRuntime(target.id)?.owner?.lease).toBe(lease)
          expect(SessionManager.getRuntime(target.id)?.owner?.phase).toBe("stopping")
          expect(SessionManager.isRunning(target.id)).toBe(true)
        })
        expect(SessionManager.isRunning(target.id)).toBe(false)
        expect((await SessionLifecycle.snapshot(target.id))?.reason).toBe("aborted")
        expect(SessionManager.hasPendingWake()).toBe(false)
      }),
    ))

  const replies = [
    { action: "question_reply", answers: [["Continue"]] },
    { action: "question_reject" },
    { action: "permission_reply", reply: "once" },
    { action: "permission_reply", reply: "reject", message: "Do not write this file" },
  ] as const

  for (const reply of replies) {
    for (const active of [false, true]) {
      test(`${reply.action}${"reply" in reply ? ` ${reply.reply}` : ""} resolves an ${active ? "active" : "idle"} target's real wait across Scopes without taking ownership`, () =>
        runtime.run(() =>
          withSessions(async ({ caller, target, targetScope, tool }) => {
            const inTarget = <T>(fn: () => T | Promise<T>) =>
              ScopeContext.provide({ scope: targetScope, workspace: target.workspace, fn })
            const targetRuntime = SessionManager.registerRuntime(target.id)
            const started = Promise.withResolvers<SessionManager.LoopLease | undefined>()
            const asked = Promise.withResolvers<string>()
            const settled = Promise.withResolvers<{ value?: unknown; error?: unknown }>()
            const cleanup = Promise.withResolvers<void>()
            const cancelled = new AbortController()
            const wake = spyOn(SessionManager, "scheduleWake")
            let continuations = 0
            let idleEvents = 0
            const unsubscribeIdle = Bus.subscribeGlobal(SessionEvent.Idle, (event) => {
              if (event.properties.sessionID === target.id) idleEvents++
            })
            const unsubscribeAsked = await inTarget(() =>
              reply.action === "permission_reply"
                ? Bus.subscribe(PermissionNext.Event.Asked, (event) => {
                    if (event.properties.sessionID === target.id) asked.resolve(event.properties.id)
                  })
                : Bus.subscribe(Question.Event.Asked, (event) => {
                    if (event.properties.sessionID === target.id) asked.resolve(event.properties.id)
                  }),
            )
            const wait = async (lease?: SessionManager.LoopLease) => {
              started.resolve(lease)
              const signal = AbortSignal.any([cancelled.signal, ...(lease ? [lease.signal] : [])])
              const pending =
                reply.action === "permission_reply"
                  ? PermissionNext.ask({
                      sessionID: target.id,
                      permission: "fixture-write",
                      patterns: ["fixture.txt"],
                      metadata: {},
                      ruleset: [],
                      signal,
                    })
                  : Question.ask({
                      sessionID: target.id,
                      questions: [
                        {
                          header: "Next step",
                          question: "Continue the task?",
                          options: [{ label: "Continue", description: "Proceed with the task" }],
                        },
                      ],
                      signal,
                    })
              const response = await pending.then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
              )
              continuations++
              settled.resolve(response)
              await cleanup.promise
            }
            const running = active ? SessionManager.run(target.id, wait) : inTarget(() => wait())
            try {
              const lease = await started.promise
              const requestID = await asked.promise
              const result = await tool.execute(
                tool.parameters.parse({ target: target.id, requestID, ...reply }),
                context(caller.id),
              )
              expect(result.metadata.action).toBe(reply.action)
              const response = await settled.promise
              if (reply.action === "question_reply") expect(response).toEqual({ value: [["Continue"]] })
              if (reply.action === "question_reject") expect(response.error).toBeInstanceOf(Question.RejectedError)
              if (reply.action === "permission_reply" && reply.reply === "once")
                expect(response).toEqual({ value: undefined })
              if (reply.action === "permission_reply" && reply.reply === "reject") {
                expect(response.error).toBeInstanceOf(PermissionNext.CorrectedError)
                expect((response.error as Error).message).toContain(reply.message)
              }
              expect(continuations).toBe(1)
              expect(SessionManager.getRuntime(target.id)).toBe(targetRuntime)
              expect(targetRuntime.owner?.lease).toBe(lease)
              if (lease) {
                expect(lease.signal.aborted).toBe(false)
                expect(targetRuntime.owner?.phase).toBe("running")
                expect(SessionManager.acquire(target.id)).toBeUndefined()
              }
              expect(await inTarget(() => Question.list())).toEqual([])
              expect(await inTarget(() => PermissionNext.list())).toEqual([])
              expect(idleEvents).toBe(0)
              expect(wake.mock.calls.filter(([sessionID]) => sessionID === target.id)).toEqual([])
              cleanup.resolve()
              await running
              expect(SessionManager.hasPendingWake()).toBe(false)
            } finally {
              cancelled.abort()
              cleanup.resolve()
              await running
              wake.mockRestore()
              unsubscribeAsked()
              unsubscribeIdle()
            }
          }),
        ))
    }
  }

  for (const action of ["compact", "worktree_enter", "worktree_leave", "set_control_profile"] as const) {
    test(`${action} still refuses a busy target without replacing its owner`, () =>
      runtime.run(() =>
        withSessions(async ({ caller, target, tool }) => {
          const lease = SessionManager.acquire(target.id)!
          SessionManager.activate(lease)
          try {
            await expect(
              tool.execute(
                tool.parameters.parse({ target: target.id, action, controlProfile: "full_access" }),
                context(caller.id),
              ),
            ).rejects.toThrow(/busy/)
            expect(SessionManager.getRuntime(target.id)?.owner?.lease).toBe(lease)
            expect(lease.signal.aborted).toBe(false)
            expect((await Session.get(target.id)).controlProfile).not.toBe("full_access")
          } finally {
            await SessionManager.finish(lease, { requestNextWork: false })
          }
        }),
      ))
  }

  test("a real model/tool loop self-aborts without deadlock, replay, or an unsettled tool result", async () => {
    await using loopRuntime = await testRuntime()
    await loopRuntime.run(async () => {
      const agent = "control-fixture"
      let modelCalls = 0
      AgentTurn.setInProcessStream(async (input) => ({
        fullStream: (async function* () {
          yield { type: "start" as const }
          yield { type: "start-step" as const }
          if (input.agent.name === agent) {
            modelCalls++
            const args = { target: input.sessionID, action: "abort" }
            yield { type: "tool-input-start" as const, id: "self-abort", toolName: "session_control" }
            yield { type: "tool-input-delta" as const, id: "self-abort", delta: JSON.stringify(args) }
            yield { type: "tool-input-end" as const, id: "self-abort" }
            yield { type: "tool-call" as const, toolCallId: "self-abort", toolName: "session_control", input: args }
          } else {
            yield { type: "text-start" as const, id: "title" }
            yield { type: "text-delta" as const, id: "title", text: "Self-stop fixture" }
            yield { type: "text-end" as const, id: "title" }
          }
          yield {
            type: "finish-step" as const,
            finishReason: input.agent.name === agent ? "tool-calls" : "stop",
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
              outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
            },
          }
          yield { type: "finish" as const }
        })(),
        usage: Promise.resolve(undefined),
        async dispose() {},
      }))
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "fixture/control",
          nano_model: "fixture/control",
          mini_model: "fixture/control",
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "synthetic-fixture-key" },
              models: { control: { name: "Control fixture", limit: { context: 128000, output: 8000 } } },
            },
          },
          agent: { [agent]: { mode: "all", permission: { "*": "allow" }, prompt: "Stop this session." } },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const finished = Promise.withResolvers<void>()
          const control = await SessionControlTool.init()
          const execute = control.execute
          control.execute = async (params, ctx) => {
            try {
              return await execute(params, ctx)
            } finally {
              finished.resolve()
            }
          }
          await ToolRegistry.register({
            ...SessionControlTool,
            exposure: { mode: "resident" },
            init: async () => control,
          })
          const session = await Session.create({ title: "Self-stop", controlProfile: "full_access" })
          try {
            await SessionInvoke.invoke({
              sessionID: session.id,
              agent,
              model: { providerID: "fixture", modelID: "control" },
              parts: [{ type: "text", text: "Stop this session through session_control." }],
            }).catch((error: unknown) => {
              expect((error as Error).name).toBe("AbortError")
            })
            await finished.promise
            await SessionManager.waitForIdle(session.id)
            const messages = await Session.messages({ sessionID: session.id })
            const assistant = messages.findLast((message) => message.info.role === "assistant")!
            const part = assistant.parts.find((part) => part.type === "tool" && part.callID === "self-abort")
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") throw new Error("Self-stop tool result was not persisted")
            expect(part.state.status).toBe("error")
            if (part.state.status === "error") expect(part.state.error).not.toContain("is busy")
            expect(assistant.info.role).toBe("assistant")
            if (assistant.info.role === "assistant")
              expect(SessionProgress.isTerminalAssistant(assistant.info)).toBe(false)
            expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("aborted")
            expect(SessionManager.isRunning(session.id)).toBe(false)
            expect(SessionManager.hasPendingWake()).toBe(false)
            expect(modelCalls).toBe(1)
          } finally {
            await Session.remove(session.id)
          }
        },
      })
    })
  })
})
