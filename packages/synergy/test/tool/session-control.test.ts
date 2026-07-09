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
  // ── create ──────────────────────────────────────────────────────────

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

  test("creates a minimal primary session without optional params", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SessionControlTool.init()
        const result = await tool.execute(input({ action: "create" }) as any, ctx)

        const sessionID = result.metadata.session.id
        const session = await Session.get(sessionID)
        expect(session.parentID).toBeUndefined()
        expect(session.title).toBeTruthy()
        expect(session.agentOverride).toBeUndefined()
        expect(session.modelOverride).toBeUndefined()
        expect(session.interaction).toBeUndefined()
        // scopeID in sessionSummary should be a truthy string from the resolved scope
        expect(result.metadata.session.scopeID).toBeTruthy()
        expect(typeof result.metadata.session.scopeID).toBe("string")

        await Session.remove(sessionID)
      },
    })
  })

  test("creates a session with interactive mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SessionControlTool.init()
        const result = await tool.execute(
          input({ action: "create", title: "Interactive session", mode: "interactive" }) as any,
          ctx,
        )

        const session = await Session.get(result.metadata.session.id)
        expect(session.interaction).toEqual(SessionInteraction.interactive("session_control"))

        await Session.remove(session.id)
      },
    })
  })

  test("creates a session without initialMessage", async () => {
    const delivered: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager as any).deliver = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      delivered.push(input)
    })

    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SessionControlTool.init()
        await tool.execute(input({ action: "create", title: "No initial msg" }) as any, ctx)
        // deliver should not be called when there is no initialMessage
        expect(delivered).toHaveLength(0)
      },
    })
  })

  test("creates a session with blank initialMessage (no delivery)", async () => {
    const delivered: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager as any).deliver = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      delivered.push(input)
    })

    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await SessionControlTool.init()
        await tool.execute(input({ action: "create", title: "Blank msg", initialMessage: "   " }) as any, ctx)
        expect(delivered).toHaveLength(0)
      },
    })
  })

  // ── set_agent ───────────────────────────────────────────────────────

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

  test("set_agent fails with nonexistent agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()
        await expect(
          tool.execute(input({ target: session.id, action: "set_agent", agent: "nonexistent_agent_xyz" }) as any, ctx),
        ).rejects.toThrow(/not found/)

        await Session.remove(session.id)
      },
    })
  })

  // ── set_model ───────────────────────────────────────────────────────

  test("set_model fails when model param is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()
        await expect(tool.execute(input({ target: session.id, action: "set_model" }) as any, ctx)).rejects.toThrow(
          "model is required",
        )

        await Session.remove(session.id)
      },
    })
  })

  test("set_model updates and returns session summary with scopeID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()
        const result = await tool.execute(
          input({
            target: session.id,
            action: "set_model",
            model: { providerID: "test-provider", modelID: "test-model" },
          }) as any,
          ctx,
        )

        expect(result.metadata.session.scopeID).toBeTruthy()
        expect(typeof result.metadata.session.scopeID).toBe("string")
        expect(result.metadata.session.id).toBe(session.id)

        await Session.remove(session.id)
      },
    })
  })

  // ── set_mode ────────────────────────────────────────────────────────

  test("set_mode to interactive updates interaction", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()
        const result = await tool.execute(
          input({ target: session.id, action: "set_mode", mode: "interactive" }) as any,
          ctx,
        )

        const updated = await Session.get(session.id)
        expect(updated.interaction).toEqual(SessionInteraction.interactive("session_control"))
        expect(result.metadata.session.interaction).toEqual(updated.interaction)

        await Session.remove(session.id)
      },
    })
  })

  test("set_mode with custom modeSource", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()
        await tool.execute(
          input({ target: session.id, action: "set_mode", mode: "unattended", modeSource: "agenda" }) as any,
          ctx,
        )

        const updated = await Session.get(session.id)
        expect(updated.interaction).toEqual(SessionInteraction.unattended("agenda"))

        await Session.remove(session.id)
      },
    })
  })

  // ── set_control_profile ─────────────────────────────────────────────

  test("set_control_profile updates session control profile", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()
        const result = await tool.execute(
          input({ target: session.id, action: "set_control_profile", controlProfile: "full_access" }) as any,
          ctx,
        )

        const updated = await Session.get(session.id)
        expect(updated.controlProfile).toBe("full_access")
        expect(result.metadata.session.controlProfile).toBe("full_access")
        expect(result.metadata.controlProfile).toBe("full_access")

        await Session.remove(session.id)
      },
    })
  })

  test("set_control_profile to autonomous and back to guarded", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()

        await tool.execute(
          input({ target: session.id, action: "set_control_profile", controlProfile: "autonomous" }) as any,
          ctx,
        )
        expect((await Session.get(session.id)).controlProfile).toBe("autonomous")

        await tool.execute(
          input({ target: session.id, action: "set_control_profile", controlProfile: "guarded" }) as any,
          ctx,
        )
        expect((await Session.get(session.id)).controlProfile).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })

  test("set_control_profile fails when controlProfile is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Target" })
        const tool = await SessionControlTool.init()
        await expect(
          tool.execute(input({ target: session.id, action: "set_control_profile" }) as any, ctx),
        ).rejects.toThrow("controlProfile is required")

        await Session.remove(session.id)
      },
    })
  })

  // ── status ──────────────────────────────────────────────────────────

  test("status returns session state with control profile and workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          title: "Check status",
          controlProfile: "guarded",
        })
        const tool = await SessionControlTool.init()
        const result = await tool.execute(input({ target: session.id, action: "status" }) as any, ctx)

        expect(result.output).toContain(session.id)
        expect(result.output).toContain("Control profile:")
        expect(result.metadata.status.controlProfile).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })

  test("status shows agent and model overrides when set", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "With overrides", agentOverride: "synergy" })
        await Session.update(session.id, (draft) => {
          draft.modelOverride = { providerID: "test-provider", modelID: "test-model" }
        })
        const tool = await SessionControlTool.init()
        const result = await tool.execute(input({ target: session.id, action: "status" }) as any, ctx)

        expect(result.metadata.status.agentOverride).toBe("synergy")
        expect(result.metadata.status.modelOverride).toEqual({
          providerID: "test-provider",
          modelID: "test-model",
        })

        await Session.remove(session.id)
      },
    })
  })

  // ── target requirement ──────────────────────────────────────────────

  test("non-create actions require target", async () => {
    const tool = await SessionControlTool.init()
    await expect(tool.execute(input({ action: "status" }) as any, ctx)).rejects.toThrow("target is required for status")
  })

  // ── sessionSummary scopeID ──────────────────────────────────────────

  test("sessionSummary includes scopeID from the session scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Scope check", agentOverride: "synergy" })
        const tool = await SessionControlTool.init()

        // set_agent returns sessionSummary in metadata
        const result = await tool.execute(
          input({ target: session.id, action: "set_agent", agent: "synergy" }) as any,
          ctx,
        )

        expect(result.metadata.session.scopeID).toBeTruthy()
        expect(typeof result.metadata.session.scopeID).toBe("string")
        // scopeID should not be undefined or null
        expect(result.metadata.session.scopeID).not.toBeUndefined()
        expect(result.metadata.session.scopeID).not.toBeNull()

        await Session.remove(session.id)
      },
    })
  })
})
