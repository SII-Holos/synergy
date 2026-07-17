import { describe, expect, test } from "bun:test"
import {
  GitHubActionProposal,
  GitHubDelivery,
  GitHubIntegrationConfig,
  GitHubTriggerDecision,
} from "../../src/github/types"

describe("GitHub integration schemas", () => {
  test("applies safe disabled defaults without storing a webhook secret", () => {
    const config = GitHubIntegrationConfig.parse({})

    expect(config).toEqual({
      enabled: false,
      eventTypes: ["issues.opened", "workflow_run.completed"],
      ciFailureThreshold: 3,
      ciFailureWindowHours: 24,
      classifierEnabled: false,
      proposalEnabled: false,
      modelBudgetNano: { maxTokens: 256, maxCost: 0.001 },
      modelBudgetProposal: { maxTokens: 2048, maxCost: 0.02 },
    })
    expect(Object.keys(GitHubIntegrationConfig.shape)).not.toContain("webhookSecret")
  })

  test("rejects malformed delivery and proposal records", () => {
    expect(() =>
      GitHubDelivery.parse({
        deliveryGuid: "delivery-1",
        eventType: "issues",
        repositoryFullName: "owner/repo",
        senderLogin: "alice",
        receivedAt: Date.now(),
        rawPayload: {},
        rawHeaders: {},
        status: "unknown",
      }),
    ).toThrow()

    expect(() =>
      GitHubActionProposal.parse({
        deliveryGuid: "delivery-1",
        triggerEventType: "issues.opened",
        proposalType: "issue_triage",
        summary: "x".repeat(501),
        rationale: "Needs triage",
        confidence: 2,
        suggestedActions: [],
      }),
    ).toThrow()
  })

  test("keeps trigger decisions explicitly model-free by default", () => {
    expect(
      GitHubTriggerDecision.parse({
        deliveryGuid: "delivery-1",
        eventType: "issues.opened",
        decision: "ambiguous_issue",
        reason: "The static gate could not classify the issue",
      }),
    ).toEqual({
      deliveryGuid: "delivery-1",
      eventType: "issues.opened",
      decision: "ambiguous_issue",
      reason: "The static gate could not classify the issue",
      classifierNeeded: false,
      proposalTriggered: false,
    })
  })
})
