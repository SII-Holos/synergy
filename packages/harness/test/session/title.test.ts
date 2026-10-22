import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentCall } from "../../src/agent/call"
import { Identifier } from "../../src/id/id"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { AgentTurn } from "../../src/session/agent-turn"
import { runInProcessStream } from "../../src/session/agent-turn/in-process"
import { LoopJob } from "../../src/session/loop-job"
import { MessageV2 } from "../../src/session/message-v2"
import { RolloutContext } from "../../src/session/rollout/context"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { createDefaultTitle, ensureTitle, isDefaultTitle } from "../../src/session/title"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const originalAgentGet = Agent.get
const originalProviderGetModel = Provider.getModel
const originalAgentCallText = AgentCall.text

afterEach(() =>
  runtime.run(() => {
    ;(Agent.get as any) = originalAgentGet
    ;(Provider.getModel as any) = originalProviderGetModel
    ;(AgentCall.text as any) = originalAgentCallText
    AgentTurn.setInProcessStream(runInProcessStream)
  }),
)

function installMocks() {
  ;(Agent.get as any) = mock(async () => ({ name: "title", prompt: "prompt", options: {} }))
  ;(Provider.getModel as any) = mock(async (providerID: string, modelID: string) => ({
    providerID,
    id: modelID,
    name: "Test Model",
    limit: { context: 100_000, output: 8_192 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: false,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai", id: modelID },
    options: {},
  }))
}

async function createSessionWithUser(title: string, text = "Hello") {
  const session = await Session.create({ title })
  const id = Identifier.ascending("message")
  const user = (await Session.updateMessage({
    id,
    sessionID: session.id,
    role: "user",
    isRoot: true,
    rootID: id,
    time: { created: Date.now() },
    agent: PrimaryAgentIdentity.names.general,
    model: { providerID: "test", modelID: "test" },
  })) as MessageV2.User
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID: session.id,
    type: "text",
    text,
  })
  return { session, user }
}

async function runEnsureTitle(sessionID: string, user: MessageV2.User) {
  const [session, history] = await Promise.all([Session.get(sessionID), Session.messages({ sessionID })])
  return ensureTitle({
    session: session!,
    user,
    history,
    providerID: "test",
    modelID: "test",
    abort: new AbortController().signal,
  })
}

describe("ensureTitle", () => {
  test("runs the title provider after the first conversation step and survives lease release", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser(createDefaultTitle())
          const calls: string[] = []
          ;(AgentCall.text as any) = mock(async () => {
            calls.push("title")
            return { text: "Deferred title" }
          })
          const lease = new AbortController()
          const ctx: LoopJob.Context = {
            session,
            sessionID: session.id,
            step: 1,
            messages: await Session.messages({ sessionID: session.id }),
            lastUser: user,
            lastUserParts: [],
            abort: lease.signal,
          }
          await LoopJob.execute(LoopJob.collect("pre", ctx), ctx)
          await LoopJob.settleDetached(session.id)
          calls.push("conversation")
          await LoopJob.execute(LoopJob.collect("post", ctx), ctx)
          lease.abort()
          await LoopJob.settleDetached(session.id)

          expect(calls).toEqual(["conversation", "title"])
          expect((await Session.get(session.id))?.title).toBe("Deferred title")
        },
      })
    }))

  test("calls AgentCall.text with the triggering user and updates the session title", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser(createDefaultTitle())
          let captured: AgentCall.TextInput | undefined
          ;(AgentCall.text as any) = mock(async (input: AgentCall.TextInput) => {
            captured = input
            return {
              text: "My generated title",
              model: { providerID: "test", id: "test" },
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          })

          await runEnsureTitle(session.id, user)

          expect(captured?.agent).toBe("title")
          expect(captured?.retries).toBe(3)
          expect(captured?.timeoutMs).toBe(120_000)
          expect(captured?.maxOutputChars).toBe(200)
          expect(captured?.sessionId).toBe(session.id)
          expect(captured?.user?.id).toBe(user.id)
          expect(captured?.fallbackModel).toMatchObject({ providerID: "test", id: "test" })

          const updated = await Session.get(session.id)
          expect(updated?.title).toBe("My generated title")
        },
      })
    }))

  test("strips think blocks, trims lines, and truncates long titles", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser(createDefaultTitle())
          const longTitle = "A".repeat(150)
          ;(AgentCall.text as any) = mock(async () => ({
            text: `<think>hidden reasoning</think>\n\n  ${longTitle}  `,
            model: { providerID: "test", id: "test" },
          }))

          await runEnsureTitle(session.id, user)

          const updated = await Session.get(session.id)
          expect(updated?.title).toBe("A".repeat(97) + "...")
        },
      })
    }))

  test("drops the title when the model output exceeds the bound", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser(createDefaultTitle())
          ;(AgentCall.text as any) = mock(async () => {
            throw new AgentCall.Error("output_too_large", "title output exceeded 200 characters")
          })

          await runEnsureTitle(session.id, user)

          const updated = await Session.get(session.id)
          expect(updated?.title).toBe(session.title)
        },
      })
    }))

  test("does not call the model for non-default titles", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser("Already titled")
          let called = false
          ;(AgentCall.text as any) = mock(async () => {
            called = true
            return { text: "ignored", model: { providerID: "test", id: "test" } }
          })

          await runEnsureTitle(session.id, user)

          expect(called).toBe(false)
        },
      })
    }))
  test("does not clobber a title renamed while the detached call was in flight", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser(createDefaultTitle())
          ;(AgentCall.text as any) = mock(async () => {
            await Session.update(session.id, (draft) => {
              draft.title = "User renamed during flight"
            })
            return { text: "Late generated title", model: { providerID: "test", id: "test" } }
          })

          await runEnsureTitle(session.id, user)

          const updated = await Session.get(session.id)
          expect(updated?.title).toBe("User renamed during flight")
        },
      })
    }))

  test("titles from the first real user message when the session has multiple real users", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser(createDefaultTitle())
          const second = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: PrimaryAgentIdentity.names.general,
            model: { providerID: "test", modelID: "test" },
          })) as MessageV2.User
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: second.id,
            sessionID: session.id,
            type: "text",
            text: "Second user message",
          })
          let captured: AgentCall.TextInput | undefined
          ;(AgentCall.text as any) = mock(async (input: AgentCall.TextInput) => {
            captured = input
            return { text: "Late generated title", model: { providerID: "test", id: "test" } }
          })

          await runEnsureTitle(session.id, second)

          expect(captured?.user?.id).toBe(second.id)
          const updated = await Session.get(session.id)
          expect(updated?.title).toBe("Late generated title")
          expect(JSON.stringify(captured?.messages)).toContain("Hello")
          expect(JSON.stringify(captured?.messages)).not.toContain("Second user message")
        },
      })
    }))

  test("recovers a failed title under the triggering run without reopening the completed first run", () =>
    runtime.run(async () => {
      installMocks()
      using model = spyOn(Agent, "getAvailableModel").mockResolvedValue(undefined)
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser(createDefaultTitle())
          const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
          const requests: AgentTurn.Input[] = []
          const systems: string[][] = []
          AgentTurn.setInProcessStream(async (input) => {
            requests.push(input)
            systems.push((await AgentTurn.prepare(input)).prepared.system)
            const first = requests.length === 1
            return {
              fullStream: (async function* () {
                if (first) throw Object.assign(new Error("getaddrinfo ENONAME model.test"), { code: "ENONAME" })
                yield { type: "text-delta", id: "title", text: "Recovered title" }
              })(),
              usage: Promise.resolve(undefined),
              async dispose() {},
            }
          })

          async function generate(lastUser: MessageV2.User) {
            const ctx: LoopJob.Context = {
              session: await Session.get(session.id),
              sessionID: session.id,
              step: 1,
              messages: await Session.messages({ sessionID: session.id }),
              lastUser,
              lastUserParts: [],
              abort: new AbortController().signal,
            }
            await RolloutContext.provide({ owner, runID: lastUser.id }, async () => {
              await LoopJob.execute(LoopJob.collect("post", ctx), ctx)
              await LoopJob.settleDetached(session.id)
            })
          }

          await RolloutLedger.beginRun(owner, user.id)
          await generate(user)
          expect((await Session.get(session.id)).title).toBe(session.title)
          const firstCalls = await RolloutLedger.calls(owner, user.id)
          expect(firstCalls).toHaveLength(1)
          expect(firstCalls[0].status).toBe("failed")
          const terminal = await RolloutLedger.finishRun(owner, user.id, "completed")

          const system = "Follow-up-only system directive: output a fixed response instead of a title."
          const secondID = Identifier.ascending("message")
          const second = (await Session.updateMessage({
            id: secondID,
            sessionID: session.id,
            role: "user",
            isRoot: true,
            rootID: secondID,
            time: { created: Date.now() },
            agent: PrimaryAgentIdentity.names.general,
            model: { providerID: "test", modelID: "test" },
            system,
          })) as MessageV2.User
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: second.id,
            sessionID: session.id,
            type: "text",
            text: "Second user message",
          })
          await RolloutLedger.beginRun(owner, second.id)
          await generate(second)

          expect((await Session.get(session.id)).title).toBe("Recovered title")
          expect(await RolloutLedger.getRun(owner, user.id)).toEqual(terminal)
          expect(await RolloutLedger.calls(owner, user.id)).toEqual(firstCalls)
          expect(await RolloutLedger.calls(owner, second.id)).toMatchObject([
            { purpose: "title", status: "completed", runID: second.id },
          ])
          expect(requests).toHaveLength(2)
          expect(requests[1].user.id).toBe(second.id)
          expect(JSON.stringify(requests[1].messages)).toContain("Hello")
          expect(JSON.stringify(requests[1].messages)).not.toContain("Second user message")
          expect(systems).toHaveLength(2)
          expect(systems[1].join("\n")).toContain("prompt")
          expect(systems[1].join("\n")).not.toContain(system)
          expect((await MessageV2.get({ sessionID: session.id, messageID: second.id })).info).toMatchObject({ system })
        },
      })
    }))

  test("keeps the default title without throwing when the call fails", () =>
    runtime.run(async () => {
      installMocks()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, user } = await createSessionWithUser(createDefaultTitle())
          ;(AgentCall.text as any) = mock(async () => {
            throw new AgentCall.Error("timeout", "title agent timed out")
          })

          await expect(runEnsureTitle(session.id, user)).resolves.toBeUndefined()

          const updated = await Session.get(session.id)
          expect(updated?.title).toBe(session.title)
        },
      })
    }))
})

describe("title helpers", () => {
  test("isDefaultTitle round-trips createDefaultTitle", () =>
    runtime.run(() => {
      expect(isDefaultTitle(createDefaultTitle())).toBe(true)
      expect(isDefaultTitle(createDefaultTitle(true))).toBe(true)
      expect(isDefaultTitle("My custom title")).toBe(false)
      expect(isDefaultTitle("")).toBe(false)
    }))
})

afterRuntimeTests(() => runtime.close())
