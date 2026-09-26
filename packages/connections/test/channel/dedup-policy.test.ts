import { expect, test } from "bun:test"
import { FeishuDedup } from "../../src/channel/provider/feishu/dedup"
import { channelToolVisibility, registerChannelToolPolicy } from "../../src/channel/tool-policy"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime({ register: registerChannelToolPolicy })

test("Feishu dedup survives owner recreation, separates accounts, and prunes expired persisted IDs", () =>
  runtime.run(async () => {
    const account = `dedup-${crypto.randomUUID()}`
    const second = `${account}-other`
    const key = (message: string, owner = account) => ["channel", "dedup", owner, message]
    const seen = new FeishuDedup({ ttlMs: 60_000, memoryMaxSize: 1 })
    try {
      expect(await seen.isDuplicate(account, "")).toBe(false)
      expect(await seen.isDuplicate(account, "first")).toBe(false)
      expect(await seen.isDuplicate(account, "first")).toBe(true)
      expect(await seen.isDuplicate(account, "second")).toBe(false)
      expect(await seen.isDuplicate(account, "first")).toBe(true)
      expect(await seen.isDuplicate(second, "first")).toBe(false)
      await Storage.write(key("expired"), { seenAt: Date.now() - 120_000 })
      const restored = new FeishuDedup({ ttlMs: 60_000 })
      expect(await restored.warmup(account)).toBe(2)
      expect(await Storage.scan(["channel", "dedup", account])).not.toContain("expired")
      expect(await restored.isDuplicate(account, "second")).toBe(true)
      await Storage.write(key("stale"), { seenAt: 0 })
      expect(await restored.isDuplicate(account, "stale")).toBe(false)
      expect((await Storage.read<{ seenAt: number }>(key("stale"))).seenAt).toBeGreaterThan(0)
    } finally {
      for (const owner of [account, second])
        for (const message of await Storage.scan(["channel", "dedup", owner])) await Storage.remove(key(message, owner))
    }
  }))

test("channel tool policy rejects unsupported endpoint capabilities and preserves unrelated tools", () =>
  runtime.run(() => {
    expect(channelToolVisibility({ toolName: "response_card" })).toMatchObject({
      code: "tool_unavailable",
      metadata: { requiredEndpoint: "channel" },
    })
    expect(channelToolVisibility({ toolName: "github_deliver_fix" })).toMatchObject({
      metadata: { requiredEndpoint: "github" },
    })
    const channel = {
      endpoint: { kind: "channel" as const, channel: { type: "feishu", accountId: "a", scopeKey: "b" } },
    }
    expect(channelToolVisibility({ toolName: "response_card", session: channel })).toBeUndefined()
    expect(channelToolVisibility({ toolName: "github_deliver_fix", session: channel })).toBeDefined()
    expect(
      channelToolVisibility({
        toolName: "github_deliver_fix",
        session: { endpoint: { ...channel.endpoint, channel: { ...channel.endpoint.channel, type: "github" } } },
      }),
    ).toBeUndefined()
    expect(channelToolVisibility({ toolName: "read_file" })).toBeUndefined()
  }))

afterRuntimeTests(() => runtime.close())
