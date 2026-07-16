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

function listInput(scope: "project" | "home" | "feishu", scopeID?: string) {
  return {
    scope,
    scopeID,
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

  test("lists ordinary project sessions globally or within one project", async () => {
    await using firstTmp = await tmpdir({ git: true })
    await using secondTmp = await tmpdir({ git: true })
    const firstScope = await firstTmp.scope()
    const secondScope = await secondTmp.scope()

    const homeSession = await ScopeContext.provide({
      scope: Scope.home(),
      fn: () => Session.create({ title: "Home Session Outside Projects" }),
    })
    const firstSessions = await ScopeContext.provide({
      scope: firstScope,
      fn: async () => {
        const regular = await Session.create({ title: "First Project Regular Session" })
        const channel = await Session.create({
          title: "First Project Feishu Session",
          endpoint: SessionEndpoint.fromChannel({
            type: "feishu",
            accountId: "first-project",
            chatId: "first-project-chat",
          }),
        })
        return { regular, channel }
      },
    })
    const secondSession = await ScopeContext.provide({
      scope: secondScope,
      fn: () => Session.create({ title: "Second Project Regular Session" }),
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const tool = await SessionListTool.init()
        const allProjects = await tool.execute(listInput("project"), ctx)

        expect(allProjects.output).toContain(firstSessions.regular.id)
        expect(allProjects.output).toContain(secondSession.id)
        expect(allProjects.output).not.toContain(firstSessions.channel.id)
        expect(allProjects.output).not.toContain(homeSession.id)

        const firstProject = await tool.execute(listInput("project", firstScope.id), ctx)
        expect(firstProject.metadata).toMatchObject({ scope: "project", scopeID: firstScope.id, total: 1 })

        expect(firstProject.output).toContain(firstSessions.regular.id)
        expect(firstProject.output).not.toContain(firstSessions.channel.id)
        expect(firstProject.output).not.toContain(secondSession.id)
        expect(firstProject.output).not.toContain(homeSession.id)
      },
    })

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: () => Session.remove(homeSession.id),
    })
    await ScopeContext.provide({
      scope: firstScope,
      fn: async () => {
        await Session.remove(firstSessions.channel.id)
        await Session.remove(firstSessions.regular.id)
      },
    })
    await ScopeContext.provide({
      scope: secondScope,
      fn: () => Session.remove(secondSession.id),
    })
    await Scope.remove(firstScope.id)
    await Scope.remove(secondScope.id)
  })

  test("identifies an empty filtered project", async () => {
    await using projectTmp = await tmpdir({ git: true })
    const projectScope = await projectTmp.scope()

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const tool = await SessionListTool.init()
        const result = await tool.execute(listInput("project", projectScope.id), ctx)

        expect(result.title).toBe("No project sessions")
        expect(result.output).toContain(`project "${projectScope.id}"`)
        expect(result.metadata).toMatchObject({ scope: "project", scopeID: projectScope.id, total: 0 })
      },
    })

    await Scope.remove(projectScope.id)
  })

  test("reports an unknown project scope ID", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const tool = await SessionListTool.init()
        const result = await tool.execute(listInput("project", "scope_missing_session_list"), ctx)

        expect(result.title).toBe("No project scope found")
        expect(result.output).toContain("Use scope_list to see available project IDs")
        expect(result.metadata).toMatchObject({
          scope: "project",
          scopeID: "scope_missing_session_list",
          total: 0,
        })
      },
    })
  })

  test.each(["home", "feishu"] as const)("rejects scopeID with %s scope", async (scope) => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const tool = await SessionListTool.init()

        await expect(tool.execute(listInput(scope, "scope_invalid_combination"), ctx)).rejects.toThrow(
          "scopeID can only be used with scope='project'",
        )
      },
    })
  })

  test("rejects an empty project scopeID", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const tool = await SessionListTool.init()

        await expect(tool.execute(listInput("project", "   "), ctx)).rejects.toThrow("scopeID cannot be empty")
      },
    })
  })
})
