import { describe, expect, test } from "bun:test"
import {
  GitHubActionProposal,
  GitHubDelivery,
  GitHubIntegrationConfig,
  GitHubPollingConfig,
  GitHubTriggerDecision,
} from "../../src/github/types"

describe("GitHub integration schemas", () => {
  test("applies safe disabled defaults with polling config included", () => {
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
      polling: {
        enabled: true,
        intervalMs: 60_000,
        overlapWindowMs: 300_000,
        pageSize: 100,
        maxPages: 30,
      },
      fixWorkflow: {
        enabled: false,
        repositoryMapping: {},
        maxRetries: 3,
        timeoutMs: 900_000,
        locatorAgent: "github-issue-locator",
        agent: "github-fix-coder",
        pushBranchPrefix: "synergy/fix/",
      },
      reviewWorkflow: {
        enabled: false,
        repositoryMapping: {},
        eventTypes: ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
        reviewCommands: ["bun test", "bun run typecheck"],
        maxRetries: 3,
        timeoutMs: 900_000,
        agent: "github-review-agent",
        publishReviewComment: true,
        publishCheckRun: true,
      },
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
      fixTriggered: false,
      reviewTriggered: false,
    })
  })
})

describe("GitHub workflow config", () => {
  test("accepts fixWorkflow with repository mapping and safe defaults", () => {
    const config = GitHubIntegrationConfig.parse({
      fixWorkflow: {
        enabled: true,
        repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
      },
    })

    expect(config.fixWorkflow).toMatchObject({
      enabled: true,
      repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
      maxRetries: 3,
      agent: "github-fix-coder",
      pushBranchPrefix: "synergy/fix/",
      locatorAgent: "github-issue-locator",
    })
  })

  test("accepts reviewWorkflow with commands and PR event types", () => {
    const config = GitHubIntegrationConfig.parse({
      reviewWorkflow: {
        enabled: true,
        repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
        reviewCommands: ["bun test", "bun run typecheck"],
      },
    })

    expect(config.reviewWorkflow).toMatchObject({
      enabled: true,
      repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
      reviewCommands: ["bun test", "bun run typecheck"],
      eventTypes: ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
      agent: "github-review-agent",
      maxRetries: 3,
    })
  })

  test("rejects fixWorkflow without repository mapping when enabled", () => {
    expect(() =>
      GitHubIntegrationConfig.parse({
        fixWorkflow: { enabled: true },
      }),
    ).toThrow()
  })

  test("rejects reviewWorkflow without repository mapping when enabled", () => {
    expect(() =>
      GitHubIntegrationConfig.parse({
        reviewWorkflow: { enabled: true },
      }),
    ).toThrow()
  })

  test("bounds autonomous workflow retries", () => {
    expect(() =>
      GitHubIntegrationConfig.parse({
        fixWorkflow: {
          enabled: true,
          repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
          maxRetries: 21,
        },
      }),
    ).toThrow()
    expect(() =>
      GitHubIntegrationConfig.parse({
        reviewWorkflow: {
          enabled: true,
          repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
          maxRetries: 21,
        },
      }),
    ).toThrow()
  })

  test("retains proposal-only behavior when workflows are disabled by default", () => {
    const config = GitHubIntegrationConfig.parse({})

    expect(config.fixWorkflow).toMatchObject({ enabled: false })
    expect(config.reviewWorkflow).toMatchObject({ enabled: false })
    expect(config.proposalEnabled).toBe(false)
  })
})

describe("GitHub delivery workflow fields", () => {
  test("accepts delivery with fix workflow task ids and output", () => {
    const delivery = GitHubDelivery.parse({
      deliveryGuid: "delivery-1",
      eventType: "issues",
      repositoryFullName: "owner/repo",
      senderLogin: "alice",
      receivedAt: Date.now(),
      rawPayload: {},
      rawHeaders: {},
      status: "received",
      fixTaskId: "ctx_fix01234567890abcde",
      fixOutput: {
        rootCause: "Null pointer in settings.ts",
        affectedFiles: ["src/settings.ts"],
        plannedChanges: "Add null guard",
        confidence: 0.85,
      },
    })

    expect(delivery.fixTaskId).toBe("ctx_fix01234567890abcde")
    expect(delivery.fixOutput?.rootCause).toBe("Null pointer in settings.ts")
    expect(delivery.fixOutput?.affectedFiles).toEqual(["src/settings.ts"])
  })

  test("accepts delivery with review workflow task id and findings", () => {
    const delivery = GitHubDelivery.parse({
      deliveryGuid: "delivery-2",
      eventType: "pull_request",
      repositoryFullName: "owner/repo",
      senderLogin: "github-actions[bot]",
      receivedAt: Date.now(),
      rawPayload: {},
      rawHeaders: {},
      status: "received",
      reviewTaskId: "ctx_review01234567890abc",
      reviewOutput: {
        defects: [{ severity: "high", file: "src/app.ts", line: 42, message: "Unhandled rejection" }],
        testResults: [{ command: "bun test", passed: 3, failed: 1, output: "..." }],
        summary: "One high-severity defect found",
      },
    })

    expect(delivery.reviewTaskId).toBe("ctx_review01234567890abc")
    expect(delivery.reviewOutput?.defects).toHaveLength(1)
    expect(delivery.reviewOutput?.defects[0].severity).toBe("high")
    expect(delivery.reviewOutput?.testResults[0].failed).toBe(1)
  })

  test("accepts processing_fix and processing_review statuses for recovery", () => {
    expect(() =>
      GitHubDelivery.parse({
        deliveryGuid: "delivery-3",
        eventType: "issues",
        repositoryFullName: "owner/repo",
        senderLogin: "alice",
        receivedAt: Date.now(),
        rawPayload: {},
        rawHeaders: {},
        status: "processing_fix",
      }),
    ).not.toThrow()

    expect(() =>
      GitHubDelivery.parse({
        deliveryGuid: "delivery-4",
        eventType: "pull_request",
        repositoryFullName: "owner/repo",
        senderLogin: "alice",
        receivedAt: Date.now(),
        rawPayload: {},
        rawHeaders: {},
        status: "processing_review",
      }),
    ).not.toThrow()
  })
})
