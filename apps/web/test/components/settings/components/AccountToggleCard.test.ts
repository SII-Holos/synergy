import { describe, expect, test } from "bun:test"
import { channelAccountVariantKeys } from "../../../../src/components/settings/channel-account-model"

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
