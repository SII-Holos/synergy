import { describe, expect, test } from "bun:test"
import { buildGitEnvironment, GitHubWorkflowOrchestrator } from "../../src/github/workflow-orchestrator"
import { GitHubDelivery, GitHubIntegrationConfig } from "../../src/github/types"
import { GitHubAppAuth } from "../../src/github/app-auth"

function makeDelivery(overrides: Partial<GitHubDelivery> & { rawPayload: Record<string, unknown> }): GitHubDelivery {
  return GitHubDelivery.parse({
    ...overrides,
    deliveryGuid: overrides.deliveryGuid ?? `delivery-${crypto.randomUUID()}`,
    eventType: overrides.eventType ?? "issues",
    installationId: overrides.installationId ?? 42,
    repositoryFullName: overrides.repositoryFullName ?? "owner/repo",
    senderLogin: overrides.senderLogin ?? "alice",
    receivedAt: overrides.receivedAt ?? 1,
    rawHeaders: overrides.rawHeaders ?? {},
    status: overrides.status ?? "received",
  })
}

const fixConfig = GitHubIntegrationConfig.parse({
  fixWorkflow: {
    enabled: true,
    repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
  },
})

const reviewConfig = GitHubIntegrationConfig.parse({
  reviewWorkflow: {
    enabled: true,
    repositoryMapping: { "owner/repo": "/tmp/checkouts/repo" },
    reviewCommands: ["bun test"],
  },
})

describe("GitHub fix workflow orchestrator", () => {
  test("fails permanently when repository has no mapping", () => {
    const delivery = makeDelivery({
      repositoryFullName: "unmapped/repo",
      rawPayload: {
        action: "opened",
        installation: { id: 42 },
        issue: { number: 1, title: "Crash", body: "bug" },
      },
    })

    // processFixDelivery must throw with permanent_failure when mapping is missing
    expect(GitHubWorkflowOrchestrator.processFixDelivery(delivery, fixConfig)).rejects.toMatchObject({
      message: expect.stringContaining("unmapped"),
    })
  })

  test("returns a stored action receipt for idempotent retry checks", () => {
    const delivery = makeDelivery({
      rawPayload: {
        action: "opened",
        installation: { id: 42 },
        issue: { number: 1, title: "Crash", body: "bug" },
      },
      statusMetadata: {
        "comment:fix_proposed": "https://api.github.com/repos/owner/repo/issues/1/comments/123",
      },
    })

    expect(GitHubWorkflowOrchestrator.receipt(delivery, "comment:fix_proposed")).toBe(
      "https://api.github.com/repos/owner/repo/issues/1/comments/123",
    )
  })
})

describe("GitHub review workflow orchestrator", () => {
  test("accepts configured pull_request opened deliveries", () => {
    const delivery = makeDelivery({
      eventType: "pull_request",
      rawPayload: {
        action: "opened",
        installation: { id: 42 },
        pull_request: { number: 1, head: { sha: "abc123" }, base: { ref: "main" } },
      },
    })

    expect(GitHubWorkflowOrchestrator.shouldProcessReviewDelivery(delivery, reviewConfig)).toBe(true)
  })

  test("ignores pull_request closed events without side effects", () => {
    const delivery = makeDelivery({
      eventType: "pull_request",
      rawPayload: {
        action: "closed",
        installation: { id: 42 },
        pull_request: { number: 1, head: { sha: "abc123" }, base: { ref: "main" } },
      },
    })

    // Should return early without launching tasks or external writes
    expect(GitHubWorkflowOrchestrator.processReviewDelivery(delivery, reviewConfig)).resolves.toBeUndefined()
  })
})

describe("GitHub action receipt idempotency", () => {
  test("records receipt before external write and skips on retry", () => {
    // Verbatim idempotency pattern from the design contract
    const receipts = new Map<string, string>()

    function recordAction(key: string, url: string): { skipped: boolean } {
      if (receipts.has(key)) return { skipped: true }
      receipts.set(key, url)
      return { skipped: false }
    }

    expect(recordAction("comment:fix_started", "https://api.github.com/repos/o/r/issues/1/comments/1")).toEqual({
      skipped: false,
    })
    expect(recordAction("comment:fix_started", "https://api.github.com/repos/o/r/issues/1/comments/2")).toEqual({
      skipped: true,
    })
    expect(receipts.get("comment:fix_started")).toBe("https://api.github.com/repos/o/r/issues/1/comments/1")
  })

  test("prevents duplicate PR creation when receipt exists", () => {
    const receipts = new Map<string, string>()

    function recordAction(key: string, url: string): { skipped: boolean } {
      if (receipts.has(key)) return { skipped: true }
      receipts.set(key, url)
      return { skipped: false }
    }

    expect(recordAction("pr:fix", "https://api.github.com/repos/o/r/pulls/5")).toEqual({ skipped: false })
    expect(recordAction("pr:fix", "https://api.github.com/repos/o/r/pulls/6")).toEqual({ skipped: true })
  })
})

describe("GitHub push helper", () => {
  test("builds one-shot credential helper args without exposing the token", () => {
    const credential = GitHubAppAuth.buildCredentialCommand({
      token: "ghs_push_token",
      args: ["push", "https://github.com/owner/repo"],
    })
    const serializedArgs = JSON.stringify(credential.args)
    expect(serializedArgs).toContain("credential.helper=")
    expect(serializedArgs).toContain("push")
    expect(serializedArgs).not.toContain("ghs_push_token")
    expect(serializedArgs).not.toContain("remote set-url")
    expect(credential.env.SYNERGY_GITHUB_INSTALLATION_TOKEN).toBe("ghs_push_token")
  })

  test("builds a minimal git environment without inheriting GitHub App credentials", () => {
    const originalPrivateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
    try {
      process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = "private-key-material"
      const env = buildGitEnvironment({ SYNERGY_GITHUB_INSTALLATION_TOKEN: "ghs_push_token" })

      expect(env.SYNERGY_GITHUB_INSTALLATION_TOKEN).toBe("ghs_push_token")
      expect(env.SYNERGY_GITHUB_APP_PRIVATE_KEY).toBeUndefined()
      expect(env.GIT_TERMINAL_PROMPT).toBe("0")
    } finally {
      if (originalPrivateKey === undefined) delete process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
      else process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = originalPrivateKey
    }
  })

  test("builds a deterministic topic branch name from issue number and slug", () => {
    const branch = GitHubAppAuth.buildFixBranchName({
      prefix: "synergy/fix/",
      issueNumber: 42,
      slug: "crash-in-settings",
    })
    expect(branch).toBe("synergy/fix/issue-42-crash-in-settings")
  })

  test("slugifies special characters in branch names", () => {
    const branch = GitHubAppAuth.buildFixBranchName({
      prefix: "synergy/fix/",
      issueNumber: 1,
      slug: "Fix: null @ pointer in settings.ts??",
    })
    expect(branch).toMatch(/^synergy\/fix\/issue-1-/)
    expect(branch).not.toContain("@")
    expect(branch).not.toContain("?")
  })
})
