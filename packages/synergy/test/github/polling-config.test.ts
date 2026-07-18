import { describe, expect, test } from "bun:test"
import { GitHubIntegrationConfig, GitHubPollingConfig, GitHubPollState } from "../../src/github/types"

describe("GitHub polling config", () => {
  test("applies safe polling defaults when polling is not specified", () => {
    const config = GitHubIntegrationConfig.parse({})
    expect(config.polling).toEqual({
      enabled: true,
      intervalMs: 60_000,
      overlapWindowMs: 300_000,
      pageSize: 100,
      maxPages: 30,
    })
  })

  test("accepts valid polling config within ranges", () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      watchedRepositories: ["owner/repo"],
      polling: {
        intervalMs: 30_000,
        overlapWindowMs: 120_000,
        pageSize: 50,
        maxPages: 10,
      },
    })
    expect(config.polling).toMatchObject({
      enabled: true,
      intervalMs: 30_000,
      overlapWindowMs: 120_000,
      pageSize: 50,
      maxPages: 10,
    })
  })

  test("rejects intervalMs below minimum (15_000)", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        intervalMs: 10_000,
      }),
    ).toThrow()
  })

  test("rejects intervalMs above maximum (300_000)", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        intervalMs: 400_000,
      }),
    ).toThrow()
  })

  test("rejects overlapWindowMs below 0", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        overlapWindowMs: -1,
      }),
    ).toThrow()
  })

  test("rejects overlapWindowMs above 600_000", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        overlapWindowMs: 700_000,
      }),
    ).toThrow()
  })

  test("rejects pageSize below 1", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        pageSize: 0,
      }),
    ).toThrow()
  })

  test("rejects pageSize above 100", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        pageSize: 200,
      }),
    ).toThrow()
  })

  test("rejects maxPages below 1", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        maxPages: 0,
      }),
    ).toThrow()
  })

  test("rejects maxPages above 100", () => {
    expect(() =>
      GitHubPollingConfig.parse({
        maxPages: 200,
      }),
    ).toThrow()
  })

  test("requires at least one repository when enabled with polling", () => {
    expect(() =>
      GitHubIntegrationConfig.parse({
        enabled: true,
        polling: { enabled: true },
        fixWorkflow: { enabled: false },
        reviewWorkflow: { enabled: false },
      }),
    ).toThrow()
  })

  test("accepts enabled with polling when watchedRepositories is configured", () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      watchedRepositories: ["owner/repo"],
    })
    expect(config.watchedRepositories).toEqual(["owner/repo"])
  })

  test("accepts enabled with polling when fixWorkflow has repositories", () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      fixWorkflow: {
        enabled: true,
        repositoryMapping: { "owner/repo": "/tmp/r" },
      },
    })
    expect(config.fixWorkflow.repositoryMapping).toEqual({ "owner/repo": "/tmp/r" })
  })

  test("accepts enabled with polling when reviewWorkflow has repositories", () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      reviewWorkflow: {
        enabled: true,
        repositoryMapping: { "owner/repo": "/tmp/r" },
      },
    })
    expect(config.reviewWorkflow.repositoryMapping).toEqual({ "owner/repo": "/tmp/r" })
  })

  test("polling.enabled=false disables polling while keeping legacy delivery processing", () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: false },
      watchedRepositories: ["owner/repo"],
    })
    expect(config.polling.enabled).toBe(false)
    expect(config.enabled).toBe(true)
  })
})

describe("GitHub poll state schema", () => {
  test("validates a fresh poll state with baseline timestamp", () => {
    const state = GitHubPollState.parse({
      repository: "owner/repo",
      baselineTimestampMs: 1_700_000_000_000,
      lastUpdatedAt: 1_700_000_000_000,
      seenPRs: {},
      seenWorkflowRunIds: {},
    })
    expect(state.baselineTimestampMs).toBe(1_700_000_000_000)
    expect(state.lastUpdatedAt).toBe(1_700_000_000_000)
  })

  test("validates poll state with bounded transition knowledge", () => {
    const state = GitHubPollState.parse({
      repository: "owner/repo",
      baselineTimestampMs: 1_700_000_000_000,
      lastUpdatedAt: 1_700_000_100_000,
      seenPRs: { "7": { number: 7, headSha: "abc123", state: "open", updatedAt: "2023-11-01T00:00:00Z" } },
      seenWorkflowRunIds: { "1001": { runId: 1001, updatedAt: "2023-11-01T00:00:00Z" } },
    })
    expect(state.seenPRs["7"].headSha).toBe("abc123")
    expect(state.seenWorkflowRunIds["1001"].runId).toBe(1001)
  })

  test("rejects poll state without repository", () => {
    expect(() =>
      GitHubPollState.parse({
        baselineTimestampMs: 1_700_000_000_000,
        lastUpdatedAt: 1_700_000_000_000,
      }),
    ).toThrow()
  })

  test("rejects poll state with negative timestamps", () => {
    expect(() =>
      GitHubPollState.parse({
        repository: "owner/repo",
        baselineTimestampMs: -1,
        lastUpdatedAt: 1_700_000_000_000,
      }),
    ).toThrow()
  })
})
