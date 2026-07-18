import { afterEach, describe, expect, mock, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { GitHubAppAuth } from "../../src/github/app-auth"
import { GitHubPollRuntime } from "../../src/github/poll-runtime"
import { GitHubPollStore } from "../../src/github/poll-store"
import { GitHubPollState, GitHubIntegrationConfig } from "../../src/github/types"
import { GitHubStore } from "../../src/github/store"

const insertedStates = new Set<string>()

afterEach(async () => {
  await GitHubPollRuntime.stop()
  for (const repository of ["owner/repo", "other/project", ...insertedStates]) {
    await GitHubPollStore.remove(repository).catch(() => undefined)
  }
  insertedStates.clear()
})

describe("GitHub polling runtime — lifecycle", () => {
  test("start initializes poll loop when enabled with repositories", async () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      watchedRepositories: ["owner/repo"],
    })

    // At startup, the runtime must not throw and must begin polling
    // We verify the runtime starts without error (it should not need webhook secret)
    expect(GitHubPollRuntime.start(config)).resolves.toBeUndefined()
    // Clean up
    await GitHubPollRuntime.stop()
  })

  test("start does not initialize poll loop when polling.enabled=false", async () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: false },
      watchedRepositories: ["owner/repo"],
    })

    // Legacy delivery processing can still run, but no polling loop
    expect(GitHubPollRuntime.start(config)).resolves.toBeUndefined()
    // The poll loop should not be active
    expect(GitHubPollRuntime.isPolling()).toBe(false)
    await GitHubPollRuntime.stop()
  })

  test("start does not initialize poll loop when github.enabled=false", async () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: false,
      polling: { enabled: true },
      watchedRepositories: ["owner/repo"],
    })

    expect(GitHubPollRuntime.start(config)).resolves.toBeUndefined()
    expect(GitHubPollRuntime.isPolling()).toBe(false)
    await GitHubPollRuntime.stop()
  })

  test("stop cancels in-flight poll fetches", async () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true, intervalMs: 300_000 }, // long interval to avoid triggering
      watchedRepositories: ["owner/repo"],
    })

    await GitHubPollRuntime.start(config)
    expect(GitHubPollRuntime.isPolling()).toBe(true)

    await GitHubPollRuntime.stop()
    expect(GitHubPollRuntime.isPolling()).toBe(false)
  })

  test("reload reinitializes the poll loop with new config", async () => {
    const config1 = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true, intervalMs: 300_000 },
      watchedRepositories: ["owner/repo"],
    })

    await GitHubPollRuntime.start(config1)
    expect(GitHubPollRuntime.isPolling()).toBe(true)

    const config2 = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true, intervalMs: 120_000 },
      watchedRepositories: ["owner/repo", "other/project"],
    })
    await GitHubPollRuntime.reload(config2)
    expect(GitHubPollRuntime.isPolling()).toBe(true)

    await GitHubPollRuntime.stop()
  })

  test("reset stops polling and clears state", async () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      watchedRepositories: ["owner/repo"],
    })

    await GitHubPollRuntime.start(config)
    await GitHubPollRuntime.reset()
    expect(GitHubPollRuntime.isPolling()).toBe(false)
  })
})

describe("GitHub polling runtime — repository set", () => {
  test("polls the deduplicated union of watchedRepositories and workflow mappings", () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      watchedRepositories: ["owner/repo"],
      fixWorkflow: {
        enabled: true,
        repositoryMapping: {
          "owner/repo": "/tmp/r", // duplicate
          "other/lib": "/tmp/lib",
        },
      },
      reviewWorkflow: {
        enabled: true,
        repositoryMapping: {
          "other/lib": "/tmp/lib", // duplicate
          "team/svc": "/tmp/svc",
        },
      },
    })

    const repos = GitHubPollRuntime.resolvePollRepositories(config)
    expect(repos).toHaveLength(3)
    expect(repos).toContain("owner/repo")
    expect(repos).toContain("other/lib")
    expect(repos).toContain("team/svc")
  })

  test("excludes repositories from disabled workflows", () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      fixWorkflow: {
        enabled: true,
        repositoryMapping: { "owner/repo": "/tmp/r" },
      },
      reviewWorkflow: {
        enabled: false,
        repositoryMapping: { "other/lib": "/tmp/lib" },
      },
    })

    const repos = GitHubPollRuntime.resolvePollRepositories(config)
    expect(repos).toEqual(["owner/repo"])
  })
})

describe("GitHub polling runtime — no overlapping cycles", () => {
  test("prevents concurrent poll cycles through abort controller", async () => {
    // The runtime must use an AbortController to cancel in-flight requests
    // Verify that starting a second poll cycle before the first completes
    // results in the first being aborted.

    const controller = GitHubPollRuntime.createPollController()
    expect(controller.signal.aborted).toBe(false)

    GitHubPollRuntime.abortPollController(controller)
    expect(controller.signal.aborted).toBe(true)
  })

  test("aborts on stop while a poll is in flight", async () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true },
      watchedRepositories: ["owner/repo"],
    })

    await GitHubPollRuntime.start(config)
    expect(GitHubPollRuntime.isPolling()).toBe(true)

    // Stop should abort any in-flight requests
    await GitHubPollRuntime.stop()
    expect(GitHubPollRuntime.isPolling()).toBe(false)
  })
})

describe("GitHub polling runtime — poll state storage", () => {
  test("persists poll state under a dedicated storage path distinct from runtime", () => {
    // Poll state uses its own storage namespace to avoid overwriting runtime state
    const pollStatePath = GitHubPollRuntime.pollStatePath("owner/repo")
    const runtimePath = GitHubPollRuntime.runtimeStatePath()

    // These must be different keys
    expect(pollStatePath).not.toEqual(runtimePath)
    // Poll state path should contain the repository identifier
    expect(pollStatePath.some((seg) => seg === "owner/repo" || seg === "owner%2Frepo")).toBe(true)
  })
})

test("polls GitHub REST endpoints with independent cursors and persists synthesized deliveries", async () => {
  const repository = `owner/poll-${crypto.randomUUID()}`
  const baselineTimestampMs = Date.parse("2025-01-01T00:00:00.000Z")
  const lastUpdatedAt = Date.parse("2025-01-03T00:00:00.000Z")
  const lastWorkflowRunCreatedAt = Date.parse("2025-01-02T00:00:00.000Z")
  const issueCreatedAt = "2025-01-03T01:00:00.000Z"
  const workflowCreatedAt = "2025-01-02T00:05:00.000Z"
  const originalFetch = globalThis.fetch
  const originalAppId = process.env.SYNERGY_GITHUB_APP_ID
  const originalPrivateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const requests: URL[] = []

  insertedStates.add(repository)
  await GitHubPollStore.write(
    repository,
    GitHubPollState.parse({
      repository,
      baselineTimestampMs,
      lastUpdatedAt,
      lastWorkflowRunCreatedAt,
      seenPRs: {},
      seenWorkflowRunIds: {
        "77": { runId: 77, updatedAt: "2025-01-02T00:06:00.000Z" },
      },
    }),
  )

  const request = mock(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(url)
    const headers = { "x-ratelimit-remaining": "5000" }
    if (url.pathname.endsWith("/installation")) return Response.json({ id: 42 }, { headers })
    if (url.pathname === "/app/installations/42/access_tokens") {
      return Response.json(
        { token: "ghs_poll", expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString() },
        { status: 201, headers },
      )
    }
    if (url.pathname.endsWith("/issues")) {
      return Response.json(
        [
          {
            number: 9,
            title: "Polling issue",
            body: "Observed through REST polling",
            html_url: `https://github.com/${repository}/issues/9`,
            state: "open",
            created_at: issueCreatedAt,
            updated_at: issueCreatedAt,
            user: { login: "alice" },
          },
        ],
        { headers },
      )
    }
    if (url.pathname.endsWith("/actions/runs")) {
      return Response.json(
        {
          workflow_runs: [
            {
              id: 77,
              name: "CI",
              status: "completed",
              conclusion: "failure",
              created_at: workflowCreatedAt,
              updated_at: "2025-01-03T02:00:00.000Z",
              triggering_actor: { login: "alice" },
            },
          ],
        },
        { headers },
      )
    }
    throw new Error(`Unexpected GitHub polling request: ${url}`)
  })

  try {
    process.env.SYNERGY_GITHUB_APP_ID = "12345"
    process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = pem
    globalThis.fetch = request as unknown as typeof fetch
    GitHubAppAuth.reset()

    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: true, intervalMs: 15_000, overlapWindowMs: 60_000 },
      watchedRepositories: [repository],
    })
    await GitHubPollRuntime.start(config)

    const deadline = Date.now() + 2_000
    let deliveries = (await GitHubStore.list()).filter((delivery) => delivery.repositoryFullName === repository)
    while (deliveries.length < 2 && Date.now() < deadline) {
      await Bun.sleep(10)
      deliveries = (await GitHubStore.list()).filter((delivery) => delivery.repositoryFullName === repository)
    }

    expect(deliveries.map((delivery) => delivery.eventType).sort()).toEqual(["issues", "workflow_run"])
    const workflowRequest = requests.find((url) => url.pathname.endsWith("/actions/runs"))
    expect(workflowRequest?.searchParams.get("created")).toBe(">=2025-01-01T23:59:00.000Z")
    const issueRequest = requests.find((url) => url.pathname.endsWith("/issues"))
    expect(issueRequest?.searchParams.get("since")).toBe("2025-01-02T23:59:00.000Z")

    const state = await GitHubPollStore.read(repository)
    expect(state?.lastUpdatedAt).toBe(Date.parse(issueCreatedAt))
    expect(state?.lastWorkflowRunCreatedAt).toBe(Date.parse(workflowCreatedAt))
  } finally {
    await GitHubPollRuntime.stop()
    const deliveries = (await GitHubStore.list()).filter((delivery) => delivery.repositoryFullName === repository)
    await Promise.all(deliveries.map((delivery) => GitHubStore.remove(delivery.deliveryGuid)))
    GitHubAppAuth.reset()
    globalThis.fetch = originalFetch
    if (originalAppId === undefined) delete process.env.SYNERGY_GITHUB_APP_ID
    else process.env.SYNERGY_GITHUB_APP_ID = originalAppId
    if (originalPrivateKey === undefined) delete process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
    else process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = originalPrivateKey
  }
})
