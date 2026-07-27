import { describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { Config } from "../../src/config/config"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "../fixture/fixture"

describe("Channel account project scope", () => {
  test("accepts an optional Feishu project directory", () => {
    const account = Config.ChannelFeishuAccount.parse({
      appId: "app",
      appSecret: "secret",
      projectDir: "/projects/synergy",
    })

    expect(account.projectDir).toBe("/projects/synergy")
    expect(
      Config.ChannelFeishuAccount.parse({
        appId: "app",
        appSecret: "secret",
      }).projectDir,
    ).toBeUndefined()
  })

  test("resolves an explicit project directory to a project scope", async () => {
    await using tmp = await tmpdir({ git: true })

    const scope = await Channel.resolveAccountScope({
      channelType: "feishu",
      accountId: "synergy-dev",
      accountConfig: { projectDir: tmp.path },
    })

    expect(scope.type).toBe("project")
    expect(scope.directory).toBe(tmp.path)
  })

  test("rejects an explicit project directory that cannot resolve to a project", async () => {
    await using tmp = await tmpdir()
    const missing = `${tmp.path}/missing`

    await expect(
      Channel.resolveAccountScope({
        channelType: "feishu",
        accountId: "synergy-dev",
        accountConfig: { projectDir: missing },
      }),
    ).rejects.toThrow("CHANNEL_PROJECT_DIR_NOT_FOUND")
  })

  test("rejects a projectDir that is not a directory", async () => {
    await using tmp = await tmpdir()
    const file = `${tmp.path}/project.txt`
    await Bun.write(file, "not a project directory")

    await expect(
      Channel.resolveAccountScope({
        channelType: "feishu",
        accountId: "synergy-dev",
        accountConfig: { projectDir: file },
      }),
    ).rejects.toThrow("CHANNEL_PROJECT_DIR_NOT_READABLE")
  })

  test("keeps accounts without a project directory in the home scope", async () => {
    const scope = await Channel.resolveAccountScope({
      channelType: "feishu",
      accountId: "default",
      accountConfig: {},
    })

    expect(scope).toEqual(Scope.home())
  })

  test("does not reuse a home endpoint session for an explicitly scoped project", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectScope = await tmp.scope()
    const endpoint = SessionEndpoint.fromChannel({
      type: "feishu",
      accountId: "synergy-dev",
      chatId: "chat-project",
      scopeKey: "topic-1",
    })

    const homeSession = await ScopeContext.provide({
      scope: Scope.home(),
      fn: () => Session.getOrCreateForEndpoint(endpoint, Scope.home(), SessionInteraction.unattended("channel:feishu")),
    })

    const projectSession = await ScopeContext.provide({
      scope: projectScope,
      fn: () => Session.getOrCreateForEndpoint(endpoint, projectScope, SessionInteraction.unattended("channel:feishu")),
    })

    expect(projectSession.id).not.toBe(homeSession.id)
    expect(projectSession.scope.id).toBe(projectScope.id)

    const reused = await ScopeContext.provide({
      scope: projectScope,
      fn: () => Session.getOrCreateForEndpoint(endpoint, projectScope, SessionInteraction.unattended("channel:feishu")),
    })

    expect(reused.id).toBe(projectSession.id)

    SessionManager.unregisterRuntime(homeSession.id)
    SessionManager.unregisterRuntime(projectSession.id)
  })
})
