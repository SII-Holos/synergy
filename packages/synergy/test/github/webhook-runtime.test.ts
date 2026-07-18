import { afterEach, describe, expect, mock, test } from "bun:test"
import { GitHubRuntime } from "../../src/github/runtime"
import { GitHubStore } from "../../src/github/store"
import { GitHubDelivery, GitHubIntegrationConfig } from "../../src/github/types"
import { GitHubWorkflowOrchestrator } from "../../src/github/workflow-orchestrator"

const deliveries = new Set<string>()

const originalOrchestrator = {
  processFixDelivery: GitHubWorkflowOrchestrator.processFixDelivery,
  processReviewDelivery: GitHubWorkflowOrchestrator.processReviewDelivery,
}

function delivery(input: { guid: string; eventType?: string; payload: Record<string, unknown> }) {
  deliveries.add(input.guid)
  return GitHubDelivery.parse({
    deliveryGuid: input.guid,
    eventType: input.eventType ?? "issues",
    repositoryFullName: "owner/repo",
    senderLogin: "alice",
    receivedAt: Date.now(),
    rawPayload: input.payload,
    rawHeaders: {},
    status: "processing",
  })
}

afterEach(async () => {
  GitHubWorkflowOrchestrator.processFixDelivery = originalOrchestrator.processFixDelivery
  GitHubWorkflowOrchestrator.processReviewDelivery = originalOrchestrator.processReviewDelivery
  await GitHubRuntime.reset()
  await Promise.all([...deliveries].map((guid) => GitHubStore.remove(guid)))
  deliveries.clear()
})

describe("GitHub shadow runtime", () => {
  test("persists an observation and ignores an unconfigured event without invoking model stages", async () => {
    const record = delivery({ guid: `runtime-ignore-${crypto.randomUUID()}`, eventType: "pull_request", payload: {} })
    await GitHubStore.accept({ ...record, status: "received" })

    await GitHubRuntime.processDelivery(
      record,
      GitHubIntegrationConfig.parse({ enabled: true, polling: { enabled: false } }),
    )

    expect(await GitHubStore.get(record.deliveryGuid)).toMatchObject({
      status: "ignored",
      triggerDecision: "ignored_type",
      observation: { eventType: "pull_request", repository: "owner/repo" },
    })
  })

  test("tracks CI failures durably and triggers only at the threshold", async () => {
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      polling: { enabled: false },
      ciFailureThreshold: 2,
    })
    const first = delivery({
      guid: `runtime-ci-1-${crypto.randomUUID()}`,
      eventType: "workflow_run",
      payload: { action: "completed", workflow_run: { name: "CI", conclusion: "failure" } },
    })
    const second = delivery({
      guid: `runtime-ci-2-${crypto.randomUUID()}`,
      eventType: "workflow_run",
      payload: { action: "completed", workflow_run: { name: "CI", conclusion: "failure" } },
    })
    await GitHubStore.accept({ ...first, status: "received" })
    await GitHubStore.accept({ ...second, status: "received" })

    await GitHubRuntime.processDelivery(first, config)
    await GitHubRuntime.processDelivery(second, config)

    expect(await GitHubStore.get(first.deliveryGuid)).toMatchObject({
      status: "ignored",
      triggerDecision: "ignored_type",
    })
    expect(await GitHubStore.get(second.deliveryGuid)).toMatchObject({
      status: "completed",
      triggerDecision: "gated_ci",
    })
  })

  test("projects pull request identity and exact head revision", async () => {
    const record = delivery({
      guid: `runtime-pr-projection-${crypto.randomUUID()}`,
      eventType: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 42 },
        repository: { default_branch: "dev" },
        pull_request: {
          number: 7,
          html_url: "https://github.com/owner/repo/pull/7",
          title: "Fix crash",
          body: "Adds a guard",
          head: { sha: "abc123", ref: "fix/crash" },
          base: { ref: "dev" },
        },
      },
    })
    await GitHubStore.accept({ ...record, status: "received" })

    await GitHubRuntime.processDelivery(
      record,
      GitHubIntegrationConfig.parse({ enabled: true, polling: { enabled: false } }),
    )

    expect((await GitHubStore.get(record.deliveryGuid))?.observation).toMatchObject({
      eventType: "pull_request.opened",
      pullRequestNumber: 7,
      headSha: "abc123",
      headRef: "fix/crash",
      baseRef: "dev",
      defaultBranch: "dev",
      installationId: 42,
      url: "https://github.com/owner/repo/pull/7",
    })
  })

  test("routes gated issues to fix delivery processing", async () => {
    const processFixDelivery = mock(async () => undefined)
    GitHubWorkflowOrchestrator.processFixDelivery = processFixDelivery
    const record = delivery({
      guid: `runtime-fix-route-${crypto.randomUUID()}`,
      payload: {
        action: "opened",
        installation: { id: 42 },
        issue: { number: 9, title: "Crash in settings", body: "The app crashes" },
      },
    })
    await GitHubStore.accept({ ...record, status: "received" })
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      fixWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/repo" } },
    })

    await GitHubRuntime.processDelivery(record, config)

    expect(processFixDelivery).toHaveBeenCalledTimes(1)
    expect((await GitHubStore.get(record.deliveryGuid))?.status).toBe("processing_fix")
  })

  test("routes configured pull requests to review processing", async () => {
    const processReviewDelivery = mock(async () => undefined)
    GitHubWorkflowOrchestrator.processReviewDelivery = processReviewDelivery
    const record = delivery({
      guid: `runtime-review-route-${crypto.randomUUID()}`,
      eventType: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 42 },
        pull_request: { number: 11, head: { sha: "def456", ref: "fix/next" }, base: { ref: "dev" } },
      },
    })
    await GitHubStore.accept({ ...record, status: "received" })
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      reviewWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/repo" } },
    })

    await GitHubRuntime.processDelivery(record, config)

    expect(processReviewDelivery).toHaveBeenCalledTimes(1)
    expect((await GitHubStore.get(record.deliveryGuid))?.status).toBe("processing_review")
  })

  test("processes independent fix deliveries without serial head-of-line blocking", async () => {
    let started = 0
    let signalStarted: (() => void) | undefined
    const bothStarted = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    GitHubWorkflowOrchestrator.processFixDelivery = mock(async () => {
      started++
      if (started === 2) signalStarted?.()
      await Bun.sleep(500)
    })
    const first = delivery({
      guid: `runtime-concurrent-fix-1-${crypto.randomUUID()}`,
      payload: {
        action: "opened",
        installation: { id: 42 },
        issue: { number: 21, title: "First crash", body: "First bug" },
      },
    })
    const second = delivery({
      guid: `runtime-concurrent-fix-2-${crypto.randomUUID()}`,
      payload: {
        action: "opened",
        installation: { id: 42 },
        issue: { number: 22, title: "Second crash", body: "Second bug" },
      },
    })
    await GitHubStore.accept({ ...first, status: "received" })
    await GitHubStore.accept({ ...second, status: "received" })
    const config = GitHubIntegrationConfig.parse({
      enabled: true,
      fixWorkflow: { enabled: true, repositoryMapping: { "owner/repo": "/tmp/repo" } },
    })

    try {
      await GitHubRuntime.start(config)
      const result = await Promise.race([
        bothStarted.then(() => "started" as const),
        Bun.sleep(250).then(() => "timeout" as const),
      ])
      expect(result).toBe("started")
      expect(started).toBe(2)
    } finally {
      await GitHubRuntime.stop()
    }
  })
})
