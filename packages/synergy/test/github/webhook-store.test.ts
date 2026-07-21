import { afterEach, describe, expect, test } from "bun:test"
import { GitHubStore } from "../../src/github/store"
import { GitHubDelivery } from "../../src/github/types"

const created = new Set<string>()

function delivery(guid: string, receivedAt: number): GitHubDelivery {
  created.add(guid)
  return GitHubDelivery.parse({
    deliveryGuid: guid,
    eventType: "issues",
    repositoryFullName: "owner/repo",
    senderLogin: "alice",
    receivedAt,
    rawPayload: { action: "opened" },
    rawHeaders: { "x-github-event": "issues", "x-github-delivery": guid },
    status: "received",
  })
}

afterEach(async () => {
  await Promise.all([...created].map((guid) => GitHubStore.remove(guid)))
  created.clear()
})

describe("GitHub delivery persistence", () => {
  test("atomically accepts one copy of a concurrent delivery", async () => {
    const guid = `delivery-concurrent-${crypto.randomUUID()}`
    const results = await Promise.all(Array.from({ length: 12 }, () => GitHubStore.accept(delivery(guid, 1))))

    expect(results.filter((result) => result.duplicate)).toHaveLength(11)
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1)
    expect((await GitHubStore.get(guid))?.deliveryGuid).toBe(guid)
  })

  test("lists and claims delivery GUIDs containing encoded path characters", async () => {
    const guid = `delivery/special?${crypto.randomUUID()}`
    await GitHubStore.accept(delivery(guid, 1))

    expect((await GitHubStore.list()).some((item) => item.deliveryGuid === guid)).toBe(true)
    expect((await GitHubStore.claimNext())?.deliveryGuid).toBe(guid)
  })
  test("claims pending deliveries in received order", async () => {
    const prefix = crypto.randomUUID()
    const newer = delivery(`delivery-new-${prefix}`, 20)
    const older = delivery(`delivery-old-${prefix}`, 10)
    await GitHubStore.accept(newer)
    await GitHubStore.accept(older)

    expect((await GitHubStore.claimNext())?.deliveryGuid).toBe(older.deliveryGuid)
    expect((await GitHubStore.claimNext())?.deliveryGuid).toBe(newer.deliveryGuid)
    expect(await GitHubStore.claimNext()).toBeUndefined()
  })

  test("recovers in-flight records after a runtime restart", async () => {
    const guid = `delivery-recovery-${crypto.randomUUID()}`
    await GitHubStore.accept(delivery(guid, 1))
    await GitHubStore.update(guid, (draft) => {
      draft.status = "processing"
    })

    expect(await GitHubStore.recoverInFlight()).toBe(1)
    expect((await GitHubStore.get(guid))?.status).toBe("retryable_failure")
    expect((await GitHubStore.claimNext())?.deliveryGuid).toBe(guid)
  })
  test("does not reclaim an excluded retryable delivery in the same worker pass", async () => {
    const guid = `delivery-retry-excluded-${crypto.randomUUID()}`
    await GitHubStore.accept(delivery(guid, 1))
    await GitHubStore.update(guid, (draft) => {
      draft.status = "retryable_failure"
    })

    expect(await GitHubStore.claimNext(new Set([guid]))).toBeUndefined()
    expect((await GitHubStore.get(guid))?.status).toBe("retryable_failure")
  })
})
