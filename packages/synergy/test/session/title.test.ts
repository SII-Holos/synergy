import { afterEach, describe, expect, mock, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentCall } from "../../src/agent/call"
import { Identifier } from "../../src/id/id"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { createDefaultTitle, ensureTitle, isDefaultTitle } from "../../src/session/title"
import { tmpdir } from "../fixture/fixture"

const originalAgentGet = Agent.get
const originalProviderGetModel = Provider.getModel
const originalAgentCallText = AgentCall.text

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Provider.getModel as any) = originalProviderGetModel
  ;(AgentCall.text as any) = originalAgentCallText
})

function installMocks() {
  ;(Agent.get as any) = mock(async () => ({ name: "title", prompt: "prompt" }))
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
  const user = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "synergy",
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

async function runEnsureTitle(sessionID: string) {
  const [session, history] = await Promise.all([Session.get(sessionID), Session.messages({ sessionID })])
  return ensureTitle({
    session: session!,
    history,
    providerID: "test",
    modelID: "test",
    abort: new AbortController().signal,
  })
}

describe("ensureTitle", () => {
  test("calls AgentCall.text with the first real user and updates the session title", async () => {
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

        await runEnsureTitle(session.id)

        expect(captured?.agent).toBe("title")
        expect(captured?.retries).toBe(2)
        expect(captured?.timeoutMs).toBe(120_000)
        expect(captured?.maxOutputChars).toBe(200)
        expect(captured?.sessionId).toBe(session.id)
        expect(captured?.user?.id).toBe(user.id)
        expect(captured?.fallbackModel).toMatchObject({ providerID: "test", id: "test" })

        const updated = await Session.get(session.id)
        expect(updated?.title).toBe("My generated title")
      },
    })
  })

  test("strips think blocks, trims lines, and truncates long titles", async () => {
    installMocks()
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await createSessionWithUser(createDefaultTitle())
        const longTitle = "A".repeat(150)
        ;(AgentCall.text as any) = mock(async () => ({
          text: `<think>hidden reasoning</think>\n\n  ${longTitle}  `,
          model: { providerID: "test", id: "test" },
        }))

        await runEnsureTitle(session.id)

        const updated = await Session.get(session.id)
        expect(updated?.title).toBe("A".repeat(97) + "...")
      },
    })
  })

  test("drops the title when the model output exceeds the bound", async () => {
    installMocks()
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await createSessionWithUser(createDefaultTitle())
        ;(AgentCall.text as any) = mock(async () => {
          throw new AgentCall.Error("output_too_large", "title output exceeded 200 characters")
        })

        await runEnsureTitle(session.id)

        const updated = await Session.get(session.id)
        expect(updated?.title).toBe(session.title)
      },
    })
  })

  test("does not call the model for non-default titles", async () => {
    installMocks()
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await createSessionWithUser("Already titled")
        let called = false
        ;(AgentCall.text as any) = mock(async () => {
          called = true
          return { text: "ignored", model: { providerID: "test", id: "test" } }
        })

        await runEnsureTitle(session.id)

        expect(called).toBe(false)
      },
    })
  })

  test("does not call the model when the session has multiple real users", async () => {
    installMocks()
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, user } = await createSessionWithUser(createDefaultTitle())
        const second = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
        })) as MessageV2.User
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: second.id,
          sessionID: session.id,
          type: "text",
          text: "Second user message",
        })
        void second
        void user
        let called = false
        ;(AgentCall.text as any) = mock(async () => {
          called = true
          return { text: "ignored", model: { providerID: "test", id: "test" } }
        })

        await runEnsureTitle(session.id)

        expect(called).toBe(false)
      },
    })
  })

  test("keeps the default title without throwing when the call fails", async () => {
    installMocks()
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await createSessionWithUser(createDefaultTitle())
        ;(AgentCall.text as any) = mock(async () => {
          throw new AgentCall.Error("timeout", "title agent timed out")
        })

        await expect(runEnsureTitle(session.id)).resolves.toBeUndefined()

        const updated = await Session.get(session.id)
        expect(updated?.title).toBe(session.title)
      },
    })
  })
})

describe("title helpers", () => {
  test("isDefaultTitle round-trips createDefaultTitle", () => {
    expect(isDefaultTitle(createDefaultTitle())).toBe(true)
    expect(isDefaultTitle(createDefaultTitle(true))).toBe(true)
    expect(isDefaultTitle("My custom title")).toBe(false)
    expect(isDefaultTitle("")).toBe(false)
  })
})
