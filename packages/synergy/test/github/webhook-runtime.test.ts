import { afterEach, describe, expect, test } from "bun:test"
import { GitHubRuntime } from "../../src/github/runtime"
import { GitHubStore } from "../../src/github/store"
import { GitHubDelivery, GitHubIntegrationConfig } from "../../src/github/types"

const deliveries = new Set<string>()

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
  await Promise.all([...deliveries].map((guid) => GitHubStore.remove(guid)))
  deliveries.clear()
})

describe("GitHub shadow runtime", () => {
  test("persists an observation and ignores an unconfigured event without invoking model stages", async () => {
    const record = delivery({ guid: `runtime-ignore-${crypto.randomUUID()}`, eventType: "pull_request", payload: {} })
    await GitHubStore.accept({ ...record, status: "received" })

    await GitHubRuntime.processDelivery(record, GitHubIntegrationConfig.parse({ enabled: true }))

    expect(await GitHubStore.get(record.deliveryGuid)).toMatchObject({
      status: "ignored",
      triggerDecision: "ignored_type",
      observation: { eventType: "pull_request", repository: "owner/repo" },
    })
  })

  test("tracks CI failures durably and triggers only at the threshold", async () => {
    const config = GitHubIntegrationConfig.parse({ enabled: true, ciFailureThreshold: 2 })
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
})
