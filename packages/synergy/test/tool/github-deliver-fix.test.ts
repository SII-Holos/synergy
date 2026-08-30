import { expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { GithubProvider, assertNotBaseBranch, resolveCanonicalBranch } from "../../src/channel/provider/github"
import { GithubDeliverFixTool } from "../../src/channel/tools/github-deliver-fix"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

// Product domains register tools via the L4 manifest
import "../../src/product-registration"

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

test("assertNotBaseBranch rejects the resolved repository base branch", () => {
  expect(() => assertNotBaseBranch("main", "main")).toThrow(/is the repository base branch/)
  expect(() => assertNotBaseBranch("refs/heads/main", "main")).toThrow(/is the repository base branch/)
  expect(() => assertNotBaseBranch("dev", "dev")).toThrow(/is the repository base branch/)
  expect(() => assertNotBaseBranch("synergy/fix/1-slug", "main")).not.toThrow()
})

test("github_deliver_fix surfaces GITHUB_DELIVERY_BASE_BRANCH when the provider rejects a base-branch delivery", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      // A provider subclass that fails exactly like deliverFix does when the
      // requested branch equals the repository base branch.
      class BaseBranchRejectingProvider extends GithubProvider {
        override async deliverFix(): Promise<never> {
          throw new Error(
            'Branch "main" is the repository base branch; create a dedicated fix branch before delivering',
          )
        }
      }
      const previous = Channel.getProvider("github")
      Channel.registerProvider(new BaseBranchRejectingProvider() as never)
      try {
        const tool = await GithubDeliverFixTool.init()
        await expect(
          tool.execute({ branch: "main", title: "Fix", body: "Fixed" }, toolContext(`ses_${crypto.randomUUID()}`)),
        ).rejects.toMatchObject({
          code: "GITHUB_DELIVERY_BASE_BRANCH",
        })
      } finally {
        if (previous) Channel.registerProvider(previous as never)
      }
    },
  })
})

test("resolveCanonicalBranch resolves HEAD and branch names, rejects missing refs", async () => {
  await using tmp = await tmpdir({ git: true })

  // HEAD on the initial branch resolves to that branch's canonical ref.
  const head = await resolveCanonicalBranch(tmp.path, "HEAD")
  expect(head).toBeDefined()
  expect(head?.startsWith("refs/heads/")).toBe(true)

  // An explicit branch name resolves to the same canonical ref.
  const branch = head!.replace(/^refs\/heads\//, "")
  expect(await resolveCanonicalBranch(tmp.path, branch)).toBe(head)

  // Missing refs are not local branches.
  expect(await resolveCanonicalBranch(tmp.path, "definitely-missing")).toBeUndefined()
})
