import { expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { GithubProvider } from "../../src/channel/provider/github"
import { GithubDeliverFixTool } from "../../src/tool/github-deliver-fix"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

function toolContext(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: `msg_${crypto.randomUUID()}`,
    agent: "github-channel-agent",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  } as Tool.Context
}

function registerGithubProvider(): () => void {
  const previous = Channel.getProvider("github")
  Channel.registerProvider(new GithubProvider() as never)
  return () => {
    if (previous) Channel.registerProvider(previous as never)
  }
}

test("github_deliver_fix tool is registered in the tool registry", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      expect(await ToolRegistry.find("github_deliver_fix")).toBeDefined()
    },
  })
})

test("github_deliver_fix rejects sessions that are not bound to a GitHub channel thread", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const restore = registerGithubProvider()
      try {
        const tool = await GithubDeliverFixTool.init()
        await expect(
          tool.execute(
            { branch: "synergy/fix/issue-1-x", title: "Fix", body: "Fixed" },
            toolContext(`ses_${crypto.randomUUID()}`),
          ),
        ).rejects.toMatchObject({
          code: "GITHUB_TOOL_NOT_IN_CHANNEL_SESSION",
        })
      } finally {
        restore()
      }
    },
  })
})

test("github_deliver_fix rejects invalid branch names", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const restore = registerGithubProvider()
      try {
        const tool = await GithubDeliverFixTool.init()
        await expect(
          tool.execute({ branch: "../evil", title: "Fix", body: "Fixed" }, toolContext(`ses_${crypto.randomUUID()}`)),
        ).rejects.toMatchObject({
          code: "GITHUB_DELIVERY_INVALID_BRANCH",
        })
      } finally {
        restore()
      }
    },
  })
})

test("github_deliver_fix surfaces GITHUB_PROVIDER_UNAVAILABLE when the provider is not a GithubProvider", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const previous = Channel.getProvider("github")
      // Register a lookalike provider that is not a GithubProvider instance.
      Channel.registerProvider({ type: "github", lifecycle: "self_connected" } as never)
      try {
        const tool = await GithubDeliverFixTool.init()
        await expect(
          tool.execute(
            { branch: "synergy/fix/issue-1-x", title: "Fix", body: "Fixed" },
            toolContext(`ses_${crypto.randomUUID()}`),
          ),
        ).rejects.toMatchObject({
          code: "GITHUB_PROVIDER_UNAVAILABLE",
        })
      } finally {
        if (previous) Channel.registerProvider(previous as never)
      }
    },
  })
})
