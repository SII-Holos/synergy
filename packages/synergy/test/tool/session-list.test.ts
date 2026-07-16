import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionListTool } from "../../src/tool/session-list"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "ses_source_session_list",
  messageID: "msg_source_session_list",
  callID: "call_source_session_list",
  agent: "synergy-max",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

function listInput(scope: "project" | "home" | "feishu") {
  return {
    scope,
    limit: 50,
    offset: 0,
  }
}

describe("tool.session_list", () => {
  test("lists every top-level session in the Home Scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()

    const homeSessions = await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const regular = await Session.create({ title: "Home Regular Session" })
        const channel = await Session.create({
          title: "Home Feishu Session",
          endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "home", chatId: "home-chat" }),
        })
        return { regular, channel }
      },
    })
    const projectSession = await ScopeContext.provide({
      scope: projectScope,
      fn: () => Session.create({ title: "Project Session Outside Home" }),
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const tool = await SessionListTool.init()
        const result = await tool.execute(listInput("home"), ctx)

        expect(result.output).toContain(homeSessions.regular.id)
        expect(result.output).toContain(homeSessions.channel.id)
        expect(result.output).not.toContain(projectSession.id)
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Session.remove(homeSessions.channel.id)
        await Session.remove(homeSessions.regular.id)
      },
    })
    await ScopeContext.provide({
      scope: projectScope,
      fn: () => Session.remove(projectSession.id),
    })
  })

  test("lists Feishu sessions across Home and project Scopes", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()

    const homeSessions = await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const regular = await Session.create({ title: "Home Non-Channel Session" })
        const channel = await Session.create({
          title: "Home Cross-Scope Feishu Session",
          endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "home", chatId: "home-cross-scope" }),
        })
        return { regular, channel }
      },
    })
    const projectSessions = await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        const regular = await Session.create({ title: "Project Non-Channel Session" })
        const channel = await Session.create({
          title: "Project Cross-Scope Feishu Session",
          endpoint: SessionEndpoint.fromChannel({
            type: "feishu",
            accountId: "project",
            chatId: "project-cross-scope",
          }),
        })
        return { regular, channel }
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const tool = await SessionListTool.init()
        const result = await tool.execute(listInput("feishu"), ctx)

        expect(result.output).toContain(homeSessions.channel.id)
        expect(result.output).toContain(projectSessions.channel.id)
        expect(result.output).not.toContain(homeSessions.regular.id)
        expect(result.output).not.toContain(projectSessions.regular.id)
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Session.remove(homeSessions.channel.id)
        await Session.remove(homeSessions.regular.id)
      },
    })
    await ScopeContext.provide({
      scope: projectScope,
      fn: async () => {
        await Session.remove(projectSessions.channel.id)
        await Session.remove(projectSessions.regular.id)
      },
    })
  })
})
