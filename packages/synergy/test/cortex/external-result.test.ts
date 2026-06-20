import { describe, expect, test, beforeAll } from "bun:test"
import { Cortex } from "../../src/cortex"
import { Instance } from "../../src/scope/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"
import type { Scope } from "../../src/scope"

async function createSessionWithAssistantText(
  scope: Scope,
  textParts: Array<{ text: string; synthetic?: boolean; ignored?: boolean }>,
  sessionID?: string,
) {
  const session = await Session.create({ scope, id: sessionID })

  // Create a dummy user message as parent
  const userMsgID = Identifier.ascending("message")
  await Session.updateMessage({
    id: userMsgID,
    sessionID: session.id,
    role: "user" as const,
    agent: "synergy-max",
    model: { providerID: "openai", modelID: "gpt-5.5" },
    time: { created: Date.now() },
  })

  const msgID = Identifier.ascending("message")
  await Session.updateMessage({
    id: msgID,
    sessionID: session.id,
    role: "assistant" as const,
    parentID: userMsgID,
    modelID: "gpt-5.5",
    providerID: "openai",
    mode: "codex",
    agent: "codex",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
    finish: "stop",
  })

  for (const tp of textParts) {
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msgID,
      sessionID: session.id,
      type: "text" as const,
      text: tp.text,
      synthetic: tp.synthetic ?? false,
      ignored: tp.ignored ?? false,
    })
  }

  return session
}

describe("extractExternalTaskResult", () => {
  beforeAll(() => {
    Cortex.reset()
  })

  test("extracts text from a single assistant message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createSessionWithAssistantText(await tmp.scope(), [{ text: "Hello from external agent" }])

        const result = await Cortex.extractExternalTaskResult(session.id)
        expect(result).toBe("Hello from external agent")
      },
    })
  })

  test("filters out synthetic text", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createSessionWithAssistantText(await tmp.scope(), [
          { text: "Real output" },
          { text: "System notification", synthetic: true },
        ])

        const result = await Cortex.extractExternalTaskResult(session.id)
        expect(result).toBe("Real output")
        expect(result).not.toContain("System notification")
      },
    })
  })

  test("filters out ignored text", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createSessionWithAssistantText(await tmp.scope(), [
          { text: "Real output" },
          { text: "Ignored content", ignored: true },
        ])

        const result = await Cortex.extractExternalTaskResult(session.id)
        expect(result).toBe("Real output")
        expect(result).not.toContain("Ignored content")
      },
    })
  })

  test("joins multiple assistant messages in order", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await tmp.scope()
        const session = await Session.create({ scope })

        // Dummy user parent
        const userMsgID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user" as const,
          agent: "synergy-max",
          model: { providerID: "openai", modelID: "gpt-5.5" },
          time: { created: Date.now() },
        })

        // Message 1
        const msg1ID = Identifier.ascending("message")
        await Session.updateMessage({
          id: msg1ID,
          sessionID: session.id,
          role: "assistant" as const,
          parentID: userMsgID,
          modelID: "gpt-5.5",
          providerID: "openai",
          mode: "codex",
          agent: "codex",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
          finish: "stop",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg1ID,
          sessionID: session.id,
          type: "text" as const,
          text: "First message",
        })

        // Message 2
        const msg2ID = Identifier.ascending("message")
        await Session.updateMessage({
          id: msg2ID,
          sessionID: session.id,
          role: "assistant" as const,
          parentID: msg1ID,
          modelID: "gpt-5.5",
          providerID: "openai",
          mode: "codex",
          agent: "codex",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
          finish: "stop",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg2ID,
          sessionID: session.id,
          type: "text" as const,
          text: "Second message",
        })

        const result = await Cortex.extractExternalTaskResult(session.id)
        expect(result).toContain("First message")
        expect(result).toContain("Second message")
      },
    })
  })

  test("returns diagnostic for session with no assistant text", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ scope: await tmp.scope() })

        const result = await Cortex.extractExternalTaskResult(session.id)
        expect(result).toBe("No assistant text found in external subagent session.")
      },
    })
  })

  test("skips user messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await tmp.scope()
        const session = await Session.create({ scope })

        // User message
        const userMsgID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user" as const,
          agent: "synergy-max",
          model: { providerID: "openai", modelID: "gpt-5.5" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsgID,
          sessionID: session.id,
          type: "text" as const,
          text: "User prompt text",
        })

        // Assistant message
        const msgID = Identifier.ascending("message")
        await Session.updateMessage({
          id: msgID,
          sessionID: session.id,
          role: "assistant" as const,
          parentID: userMsgID,
          modelID: "gpt-5.5",
          providerID: "openai",
          mode: "codex",
          agent: "codex",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
          finish: "stop",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msgID,
          sessionID: session.id,
          type: "text" as const,
          text: "Assistant output",
        })

        const result = await Cortex.extractExternalTaskResult(session.id)
        expect(result).toBe("Assistant output")
        expect(result).not.toContain("User prompt")
      },
    })
  })

  test("truncates output exceeding char limit", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const longText = "A".repeat(150_000)
        const session = await createSessionWithAssistantText(await tmp.scope(), [{ text: longText }])

        const result = await Cortex.extractExternalTaskResult(session.id)
        expect(result.length).toBeLessThan(150_000)
        expect(result).toContain("truncated")
      },
    })
  })
})
