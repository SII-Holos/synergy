import { expect, test } from "bun:test"
import { githubToolVisibility } from "../src/tool-policy"
import { GithubDeliverFixTool } from "../src/channel/tools/github-deliver-fix"
import { createDomainAgents } from "../src/agents"
test("GitHub fix delivery owns call details while the agent owns publication responsibility", async () => {
  const agent = createDomainAgents({ defaults: [], user: [], role: () => undefined })["github-channel-agent"]
  expect(agent.prompt).toContain("managed GitHub fix-delivery surface")
  expect(agent.prompt).toContain("Never use the GitHub CLI, push manually, change remotes, or force operations")
  expect(agent.prompt).not.toMatch(/calling the `github_deliver_fix`|with the branch name|synergy\/fix\//)
  const tool = await GithubDeliverFixTool.init()
  expect(tool.description).toContain("synergy/fix/<issue-number>-<slug>")
  expect(tool.description).toContain("root cause, changes, and test results")
  expect(tool.description).toContain("first updates that PR's head branch")
  expect(tool.description).toContain("opens or reuses a new PR")
  expect(
    tool.parameters.parse({ branch: "synergy/fix/123-slug", title: "Fix", body: "Cause, changes, tests" }),
  ).toEqual({
    branch: "synergy/fix/123-slug",
    title: "Fix",
    body: "Cause, changes, tests",
  })
})

test("GitHub delivery is available only to a GitHub Channel endpoint", () => {
  expect(githubToolVisibility({ toolName: "github_deliver_fix" })).toMatchObject({
    metadata: { requiredEndpoint: "github" },
  })
  expect(
    githubToolVisibility({
      toolName: "github_deliver_fix",
      session: { endpoint: { kind: "channel", channel: { type: "feishu", accountId: "a", scopeKey: "b" } } },
    }),
  ).toBeDefined()
  expect(
    githubToolVisibility({
      toolName: "github_deliver_fix",
      session: { endpoint: { kind: "channel", channel: { type: "github", accountId: "a", scopeKey: "b" } } },
    }),
  ).toBeUndefined()
  expect(githubToolVisibility({ toolName: "read_file" })).toBeUndefined()
})
