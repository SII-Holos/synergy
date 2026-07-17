import { describe, expect, test } from "bun:test"
import { evaluateGitHubDelivery, shouldTrackGitHubWorkflowConclusion } from "../../src/github/gate"
import { GitHubDelivery, GitHubIntegrationConfig } from "../../src/github/types"

function delivery(input: Partial<GitHubDelivery> = {}): GitHubDelivery {
  return GitHubDelivery.parse({
    deliveryGuid: "delivery-1",
    eventType: "issues",
    installationId: 1,
    repositoryFullName: "owner/repo",
    senderLogin: "alice",
    receivedAt: 1,
    rawPayload: {
      action: "opened",
      issue: { title: "Crash when opening settings", body: "The application crashes with an error every time." },
      repository: { full_name: "owner/repo" },
      sender: { login: "alice" },
    },
    rawHeaders: { "x-github-event": "issues", "x-github-delivery": "delivery-1" },
    status: "received",
    ...input,
  })
}

const config = GitHubIntegrationConfig.parse({ proposalEnabled: true })

describe("GitHub L0 gate", () => {
  test("drops bot and unconfigured events without requesting a model", () => {
    expect(evaluateGitHubDelivery(delivery({ senderLogin: "github-actions[bot]" }), config, 0)).toMatchObject({
      decision: "ignored_bot",
      classifierNeeded: false,
      proposalTriggered: false,
    })
    expect(evaluateGitHubDelivery(delivery({ eventType: "pull_request" }), config, 0)).toMatchObject({
      decision: "ignored_type",
      classifierNeeded: false,
      proposalTriggered: false,
    })
  })

  test("gates clear bug reports and leaves ambiguous issues to the optional nano classifier", () => {
    expect(evaluateGitHubDelivery(delivery(), config, 0)).toMatchObject({
      decision: "gated_issue",
      proposalTriggered: true,
    })

    const ambiguous = delivery({
      rawPayload: {
        action: "opened",
        issue: { title: "Question", body: "Can someone help me understand this?" },
      },
    })
    expect(
      evaluateGitHubDelivery(ambiguous, GitHubIntegrationConfig.parse({ classifierEnabled: true }), 0),
    ).toMatchObject({
      decision: "ambiguous_issue",
      classifierNeeded: true,
      proposalTriggered: false,
    })
  })

  test("requires the configured consecutive CI failure threshold", () => {
    const workflow = delivery({
      eventType: "workflow_run",
      rawPayload: {
        action: "completed",
        workflow_run: { name: "CI", conclusion: "failure", html_url: "https://example.test/run/1" },
      },
    })

    expect(evaluateGitHubDelivery(workflow, config, 2)).toMatchObject({
      decision: "gated_ci",
      proposalTriggered: true,
    })
    expect(evaluateGitHubDelivery(workflow, config, 1)).toMatchObject({
      decision: "ignored_type",
      proposalTriggered: false,
    })
  })

  test("tracks workflow conclusions only after the shared deterministic filters pass", () => {
    const workflow = delivery({
      eventType: "workflow_run",
      rawPayload: { action: "completed", workflow_run: { name: "CI", conclusion: "failure" } },
    })

    expect(shouldTrackGitHubWorkflowConclusion(workflow, config)).toBe(true)
    expect(shouldTrackGitHubWorkflowConclusion(delivery({ ...workflow, senderLogin: "actions[bot]" }), config)).toBe(
      false,
    )
    expect(
      shouldTrackGitHubWorkflowConclusion(
        workflow,
        GitHubIntegrationConfig.parse({ watchedRepositories: ["other/repo"] }),
      ),
    ).toBe(false)
  })
  test("filters repositories before any model decision", () => {
    const watched = GitHubIntegrationConfig.parse({ watchedRepositories: ["other/repo"], classifierEnabled: true })
    expect(evaluateGitHubDelivery(delivery(), watched, 0)).toMatchObject({
      decision: "ignored_type",
      classifierNeeded: false,
      proposalTriggered: false,
    })
  })
})
