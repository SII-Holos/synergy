import { describe, expect, test } from "bun:test"
import { evaluateGitHubDelivery } from "../../src/github/gate"
import { GitHubDelivery, GitHubIntegrationConfig } from "../../src/github/types"

function delivery(input: Partial<GitHubDelivery> & { rawPayload: Record<string, unknown> }): GitHubDelivery {
  return GitHubDelivery.parse({
    deliveryGuid: input.deliveryGuid ?? `delivery-${crypto.randomUUID()}`,
    eventType: input.eventType ?? "issues",
    installationId: 1,
    repositoryFullName: input.repositoryFullName ?? "owner/repo",
    senderLogin: input.senderLogin ?? "alice",
    receivedAt: 1,
    rawPayload: input.rawPayload,
    rawHeaders: input.rawHeaders ?? {},
    status: "received",
  })
}

describe("GitHub workflow gate — PR events", () => {
  test("gates pull_request opened for review when reviewWorkflow is enabled, even for bot senders", () => {
    const config = GitHubIntegrationConfig.parse({
      reviewWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/r" } },
    })
    const pr = delivery({
      eventType: "pull_request",
      rawPayload: {
        action: "opened",
        pull_request: { number: 1, head: { sha: "abc123" }, base: { ref: "main" } },
      },
    })

    const result = evaluateGitHubDelivery(pr, config, 0)
    expect(result.decision).toBe("gated_pr")
    expect(result.reviewTriggered).toBe(true)
    expect(result.proposalTriggered).toBe(false)
  })

  test("gates pull_request opened for review even when sender is a GitHub App bot", () => {
    const config = GitHubIntegrationConfig.parse({
      reviewWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/r" } },
    })
    const botPr = delivery({
      eventType: "pull_request",
      senderLogin: "synergy-app[bot]",
      rawPayload: {
        action: "opened",
        pull_request: { number: 2, head: { sha: "def456" }, base: { ref: "main" } },
      },
    })

    const result = evaluateGitHubDelivery(botPr, config, 0)
    expect(result.decision).toBe("gated_pr")
    expect(result.reviewTriggered).toBe(true)
  })

  test("gates pull_request reopened and synchronize events", () => {
    const config = GitHubIntegrationConfig.parse({
      reviewWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/r" } },
    })

    for (const action of ["reopened", "synchronize"]) {
      const pr = delivery({
        eventType: "pull_request",
        rawPayload: {
          action,
          pull_request: { number: 1, head: { sha: "abc123" }, base: { ref: "main" } },
        },
      })
      const result = evaluateGitHubDelivery(pr, config, 0)
      expect(result.decision).toBe("gated_pr")
      expect(result.reviewTriggered).toBe(true)
    }
  })

  test("ignores pull_request closed events", () => {
    const config = GitHubIntegrationConfig.parse({
      reviewWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/r" } },
    })
    const closed = delivery({
      eventType: "pull_request",
      rawPayload: {
        action: "closed",
        pull_request: { number: 1, head: { sha: "abc123" }, base: { ref: "main" } },
      },
    })

    const result = evaluateGitHubDelivery(closed, config, 0)
    expect(result.decision).toBe("ignored_type")
    expect(result.reviewTriggered).toBeFalsy()
  })

  test("ignores pull_request events when reviewWorkflow is disabled", () => {
    const config = GitHubIntegrationConfig.parse({})
    const pr = delivery({
      eventType: "pull_request",
      rawPayload: {
        action: "opened",
        pull_request: { number: 1, head: { sha: "abc123" }, base: { ref: "main" } },
      },
    })

    const result = evaluateGitHubDelivery(pr, config, 0)
    expect(result.decision).toBe("ignored_type")
    expect(result.reviewTriggered).toBeFalsy()
    expect(result.proposalTriggered).toBe(false)
  })
})

describe("GitHub workflow gate — issue fix", () => {
  test("sets fixTriggered on gated_issue when fixWorkflow is enabled", () => {
    const config = GitHubIntegrationConfig.parse({
      fixWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/r" } },
    })
    const issue = delivery({
      eventType: "issues",
      rawPayload: {
        action: "opened",
        issue: { title: "Crash when opening settings", body: "The application crashes with an error." },
      },
    })

    const result = evaluateGitHubDelivery(issue, config, 0)
    expect(result.decision).toBe("gated_issue")
    expect(result.fixTriggered).toBe(true)
    expect(result.proposalTriggered).toBe(false)
  })

  test("still rejects bot-created issues even when fixWorkflow is enabled", () => {
    const config = GitHubIntegrationConfig.parse({
      fixWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/r" } },
    })
    const botIssue = delivery({
      eventType: "issues",
      senderLogin: "dependabot[bot]",
      rawPayload: {
        action: "opened",
        issue: { title: "Crash report", body: "bug" },
      },
    })

    const result = evaluateGitHubDelivery(botIssue, config, 0)
    expect(result.decision).toBe("ignored_bot")
    expect(result.fixTriggered).toBeFalsy()
  })

  test("does not set fixTriggered when fixWorkflow is disabled", () => {
    const config = GitHubIntegrationConfig.parse({ proposalEnabled: true })
    const issue = delivery({
      eventType: "issues",
      rawPayload: {
        action: "opened",
        issue: { title: "Crash when opening settings", body: "bug" },
      },
    })

    const result = evaluateGitHubDelivery(issue, config, 0)
    expect(result.decision).toBe("gated_issue")
    expect(result.fixTriggered).toBeFalsy()
    expect(result.proposalTriggered).toBe(true)
  })
})

describe("GitHub workflow gate — missing mapping errors", () => {
  test("rejects fix delivery when repository has no mapping", () => {
    const config = GitHubIntegrationConfig.parse({
      fixWorkflow: { enabled: true, repositoryMapping: { "other/repo": "/tmp/r" } },
    })
    const issue = delivery({
      eventType: "issues",
      repositoryFullName: "unmapped/repo",
      rawPayload: {
        action: "opened",
        issue: { title: "Crash", body: "bug" },
      },
    })

    const result = evaluateGitHubDelivery(issue, config, 0)
    expect(result.decision).toBe("gated_issue")
    expect(result.fixTriggered).toBe(false)
    expect(result.reason).toContain("unmapped")
  })

  test("rejects review delivery when repository has no mapping", () => {
    const config = GitHubIntegrationConfig.parse({
      reviewWorkflow: { enabled: true, repositoryMapping: { "other/repo": "/tmp/r" } },
    })
    const pr = delivery({
      eventType: "pull_request",
      repositoryFullName: "unmapped/repo",
      rawPayload: {
        action: "opened",
        pull_request: { number: 1, head: { sha: "abc123" }, base: { ref: "main" } },
      },
    })

    const result = evaluateGitHubDelivery(pr, config, 0)
    expect(result.reviewTriggered).toBe(false)
    expect(result.reason).toContain("unmapped")
  })
})
