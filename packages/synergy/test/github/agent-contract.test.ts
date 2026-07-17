import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { ScopeContext } from "../../src/scope/context"
import { buildGitHubProposalLaunchInput } from "../../src/github/proposal"
import { tmpdir } from "../fixture/fixture"

test("GitHub internal agents are hidden, tool-free, and use cost-appropriate model roles", async () => {
  await using tmp = await tmpdir({
    config: {
      model: "openai/default-test",
      nano_model: "openai/nano-test",
      mid_model: "openai/mid-test",
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const classifier = await Agent.get("github-shadow-classifier")
      const proposer = await Agent.get("github-shadow-proposer")

      expect(classifier).toMatchObject({ hidden: true, native: true, modelRole: "nano", temperature: 0 })
      expect(proposer).toMatchObject({ hidden: true, native: true, modelRole: "mid", temperature: 0 })
      expect(classifier?.permission).toEqual(
        expect.arrayContaining([expect.objectContaining({ permission: "*", action: "deny" })]),
      )
      expect(proposer?.permission).toEqual(
        expect.arrayContaining([expect.objectContaining({ permission: "*", action: "deny" })]),
      )
    },
  })
})

test("GitHub proposals launch as silent hidden structured Cortex work", () => {
  expect(
    buildGitHubProposalLaunchInput({
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      deliveryGuid: "delivery-1",
      eventType: "issues.opened",
      observation: { eventType: "issues.opened", repository: "owner/repo" },
      maxOutputTokens: 512,
      maxCost: 0.01,
    }),
  ).toMatchObject({
    agent: "github-shadow-proposer",
    executionRole: "delegated_subagent",
    category: "background",
    visibility: "hidden",
    notifyParentOnComplete: false,
    tools: {},
    output: { mode: "structured", maxRepairTurns: 1 },
    maxOutputTokens: 512,
    maxCost: 0.01,
  })
})
