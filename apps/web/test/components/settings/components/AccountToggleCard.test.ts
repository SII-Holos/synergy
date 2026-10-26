import { describe, expect, test } from "bun:test"
import {
  canRefreshChannelAccount,
  channelAccountActionKey,
  channelAccountVariantKeys,
  channelRuntimeStatusLabel,
  isChannelAccountActionPending,
  shouldRefreshChannelStatuses,
} from "../../../../src/components/settings/channel-account-model"

describe("Feishu account model selection", () => {
  test("exposes the selected model variants for the account effort control", () => {
    const providers = [
      {
        providerId: "openai-codex",
        providerName: "OpenAI Codex",
        models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", variantKeys: ["low", "high"] }],
      },
    ]

    expect(channelAccountVariantKeys("openai-codex/gpt-5.6-sol", providers)).toEqual(["low", "high"])
    expect(channelAccountVariantKeys("", providers)).toEqual([])
    expect(channelAccountVariantKeys("openai-codex/unknown", providers)).toEqual([])
  })
})

describe("Channel account presentation", () => {
  test("maps the real channel runtime status for Settings presentation", () => {
    expect(channelRuntimeStatusLabel({ status: "connected" }).message).toBe("Connected")
    expect(channelRuntimeStatusLabel({ status: "syncing" }).message).toBe("Syncing…")
    expect(channelRuntimeStatusLabel({ status: "failed", error: "transport failed" }).message).toBe("Connection failed")
    expect(channelRuntimeStatusLabel(undefined).message).toBe("Status unavailable")
  })

  test("allows project refresh only for connected accounts", () => {
    expect(canRefreshChannelAccount({ status: "connected" })).toBe(true)
    expect(canRefreshChannelAccount({ status: "syncing" })).toBe(false)
    expect(canRefreshChannelAccount({ status: "disabled" })).toBe(false)
    expect(canRefreshChannelAccount({ status: "disconnected" })).toBe(false)
    expect(canRefreshChannelAccount({ status: "failed", error: "transport failed" })).toBe(false)
    expect(canRefreshChannelAccount(undefined)).toBe(false)
  })

  test("refreshes runtime status only for Channel lifecycle events", () => {
    expect(shouldRefreshChannelStatuses("channel.connected")).toBe(true)
    expect(shouldRefreshChannelStatuses("channel.disconnected")).toBe(true)
    expect(shouldRefreshChannelStatuses("session.updated")).toBe(false)
    expect(shouldRefreshChannelStatuses(undefined)).toBe(false)
  })

  test("isolates pending state by account and action", () => {
    const pending = new Set([channelAccountActionKey("refresh", "agent-a")])

    expect(isChannelAccountActionPending(pending, "refresh", "agent-a")).toBe(true)
    expect(isChannelAccountActionPending(pending, "diagnostics", "agent-a")).toBe(false)
    expect(isChannelAccountActionPending(pending, "refresh", "agent-b")).toBe(false)
  })
})
