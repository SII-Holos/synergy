import { afterEach, describe, expect, mock, test } from "bun:test"
import { SessionControlTool } from "../../src/tool/session-control"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionManager } from "../../src/session/manager"
import { ScopeContext } from "../../src/scope/context"
import { createUserMessage } from "../../src/session/input"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "ses_source123",
  messageID: "msg_source123",
  callID: "call_source123",
  agent: "synergy",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

const originalDeliver = SessionManager.deliver

function input(overrides: Record<string, unknown>) {
  return {
    baseRef: "current" as const,
    cleanup: "keep" as const,
    force: false,
    ...overrides,
  }
}

afterEach(() => {
  ;(SessionManager as any).deliver = originalDeliver
})

describe("tool.session_control", () => {
  test("creates a primary session with overrides and queued initial message", async () => {
    const delivered: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager as any).deliver = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      delivered.push(input)
    })

    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SessionControlTool.init()
        const result = await tool.execute(
          input({
            action: "create",
            title: "Managed session",
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            mode: "unattended",
            controlProfile: "autonomous",
            initialMessage: "Start the managed task",
          }) as any,
          ctx,
        )

        const sessionID = result.metadata.session.id
        const session = await Session.get(sessionID)
        expect(session.parentID).toBeUndefined()
        expect(session.title).toBe("Managed session")
        expect(session.agentOverride).toBe("synergy")
        expect(session.modelOverride).toEqual({ providerID: "test-provider", modelID: "test-model" })
        expect(session.interaction).toEqual(SessionInteraction.unattended("session_control"))
        expect(session.controlProfile).toBe("autonomous")
        expect(delivered).toHaveLength(1)
        expect(delivered[0].target).toBe(sessionID)
        expect(delivered[0].waitForProcessing).toBe(false)
        expect(delivered[0].mail.type).toBe("user")
        if (delivered[0].mail.type === "user") {
          expect(delivered[0].mail.agent).toBe("synergy")
          expect(delivered[0].mail.model).toEqual({ providerID: "test-provider", modelID: "test-model" })
          expect(delivered[0].mail.metadata?.source).toBe("session_control")
          expect(delivered[0].mail.metadata?.sourceSessionID).toBe(ctx.sessionID)
        }

        await Session.remove(sessionID)
      },
    })
  })

  test("sets agent, model, and mode overrides used by later user messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()

        await tool.execute(input({ target: session.id, action: "set_agent", agent: "synergy" }) as any, ctx)
        await tool.execute(
          input({
            target: session.id,
            action: "set_model",
            model: { providerID: "test-provider", modelID: "test-model" },
          }) as any,
          ctx,
        )
        await tool.execute(input({ target: session.id, action: "set_mode", mode: "unattended" }) as any, ctx)

        const updated = await Session.get(session.id)
        expect(updated.agentOverride).toBe("synergy")
        expect(updated.modelOverride).toEqual({ providerID: "test-provider", modelID: "test-model" })
        expect(updated.interaction).toEqual(SessionInteraction.unattended("session_control"))

        const message = await createUserMessage({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Use overrides" }],
        })
        expect(message.info.role).toBe("user")
        if (message.info.role === "user") {
          expect(message.info.agent).toBe("synergy")
          expect(message.info.model).toEqual({ providerID: "test-provider", modelID: "test-model" })
        }

        await Session.remove(session.id)
      },
    })
  })
})
