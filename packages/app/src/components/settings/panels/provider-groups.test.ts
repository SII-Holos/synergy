import { describe, expect, test } from "bun:test"
import { groupProviderConnections } from "./provider-groups"

describe("provider settings groups", () => {
  test("every provider appears in exactly one group and attention wins over recommendation", () => {
    const groups = groupProviderConnections(
      [
        {
          id: "openai-codex",
          connected: false,
          health: { providerID: "openai-codex", status: "action_required" as const },
        },
        { id: "openrouter", connected: true, health: { providerID: "openrouter", status: "connected" as const } },
        { id: "anthropic", connected: true },
        { id: "deepseek", connected: false },
        { id: "custom", connected: false },
      ],
      new Set(["openai-codex", "openrouter", "deepseek"]),
    )

    expect(groups.needsAttention.map((provider) => provider.id)).toEqual(["openai-codex"])
    expect(groups.recommended.map((provider) => provider.id)).toEqual(["openrouter", "deepseek"])
    expect(groups.connected.map((provider) => provider.id)).toEqual(["anthropic"])
    expect(groups.other.map((provider) => provider.id)).toEqual(["custom"])
    expect(Object.values(groups).flat()).toHaveLength(5)
  })
})
