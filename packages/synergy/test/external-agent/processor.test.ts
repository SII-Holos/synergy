import { describe, expect, test } from "bun:test"
import { ExternalAgentProcessor } from "../../src/external-agent/processor"
import type { ExternalAgent } from "../../src/external-agent/bridge"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("ExternalAgentProcessor", () => {
  test("writes external assistant results as visible messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ scope: await tmp.scope() })
        const parent = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          visible: true,
          isRoot: true,
          rootID: Identifier.ascending("message"),
          agent: "codex",
          model: { providerID: "openai-codex", modelID: "gpt-5.5" },
          time: { created: Date.now() },
        })
        const adapter: ExternalAgent.Adapter = {
          name: "codex",
          started: true,
          capabilities: { modelSwitch: true, interrupt: true },
          async discover() {
            return { available: true }
          },
          async start() {},
          async *turn() {
            yield { type: "text_delta", text: "Codex finished successfully." }
            yield { type: "turn_complete" }
          },
          async interrupt() {},
          async shutdown() {},
        }

        const result = await ExternalAgentProcessor.process({
          sessionID: session.id,
          agent: "codex",
          adapter,
          parentID: parent.id,
          model: { providerID: "openai-codex", modelID: "gpt-5.5" },
          context: { sessionID: session.id, prompt: "test" },
          approvalDelegate: async () => false,
          abort: new AbortController().signal,
        })

        expect(result.info.visible).toBe(true)
        expect(result.parts.some((part) => part.type === "text" && part.text.includes("Codex finished"))).toBe(true)

        const messages = await Session.messages({ sessionID: session.id })
        const assistant = messages.find((message) => message.info.id === result.info.id)?.info
        expect(assistant?.visible).toBe(true)
      },
    })
  })
})
