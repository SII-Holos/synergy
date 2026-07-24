import { describe, expect, test } from "bun:test"
import {
  channelAccountActionKey,
  channelAccountVariantKeys,
  channelRuntimeStatusLabel,
  clarusAccountDisplayName,
  clarusDiagnosticsFilename,
  isChannelAccountActionPending,
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

describe("Clarus account presentation", () => {
  test("uses the Holos profile name without exposing the internal account ID", () => {
    expect(
      clarusAccountDisplayName("3c1d9f62-e2e1-47fd-bc59-9f1cbd0d9ed2", [
        {
          agentId: "3c1d9f62-e2e1-47fd-bc59-9f1cbd0d9ed2",
          createdAt: 1,
          updatedAt: 1,
          profile: { name: "Research Agent", description: "", avatarUrl: null },
        },
      ]),
    ).toBe("Research Agent")
  })

  test("falls back to a generic Holos Agent label rather than a UUID", () => {
    expect(clarusAccountDisplayName("3c1d9f62-e2e1-47fd-bc59-9f1cbd0d9ed2", [])).toBe("Holos Agent")
  })

  test("uses a stable diagnostics filename without exposing the internal account ID", () => {
    const accountID = "3c1d9f62-e2e1-47fd-bc59-9f1cbd0d9ed2"
    const filename = clarusDiagnosticsFilename()

    expect(filename).toBe("clarus-diagnostics.ndjson")
    expect(filename).not.toContain(accountID)
  })

  test("maps the real channel runtime status for Settings presentation", () => {
    expect(channelRuntimeStatusLabel({ status: "connected" }).message).toBe("Connected")
    expect(channelRuntimeStatusLabel({ status: "syncing" }).message).toBe("Syncing…")
    expect(channelRuntimeStatusLabel({ status: "failed", error: "transport failed" }).message).toBe("Connection failed")
    expect(channelRuntimeStatusLabel(undefined).message).toBe("Status unavailable")
  })

  test("isolates pending state by account and action", () => {
    const pending = new Set([channelAccountActionKey("refresh", "agent-a")])

    expect(isChannelAccountActionPending(pending, "refresh", "agent-a")).toBe(true)
    expect(isChannelAccountActionPending(pending, "diagnostics", "agent-a")).toBe(false)
    expect(isChannelAccountActionPending(pending, "refresh", "agent-b")).toBe(false)
  })
})
