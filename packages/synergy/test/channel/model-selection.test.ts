import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { resolveChannelAccountInvocation } from "../../src/channel/model-selection"

describe("channel account model selection", () => {
  test("accepts a model variant in Feishu account config", () => {
    const result = Config.ChannelFeishuAccount.parse({
      appId: "app",
      appSecret: "secret",
      model: "openai-codex/gpt-5.6-sol",
      variant: "high",
    })

    expect(result.variant).toBe("high")
  })

  test("uses the configured account model and variant for an unoverridden session", () => {
    expect(
      resolveChannelAccountInvocation({
        accountConfig: {
          model: "openai-codex/gpt-5.6-sol",
          variant: "high",
        },
      }),
    ).toEqual({
      model: { providerID: "openai-codex", modelID: "gpt-5.6-sol" },
      variant: "high",
    })
  })

  test("keeps an explicit session model ahead of the account default", () => {
    expect(
      resolveChannelAccountInvocation({
        accountConfig: {
          model: "openai-codex/gpt-5.6-sol",
          variant: "high",
        },
        sessionModelOverride: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
      }),
    ).toEqual({
      model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    })
  })

  test("does not apply a variant without a valid account model", () => {
    expect(resolveChannelAccountInvocation({ accountConfig: { variant: "high" } })).toEqual({})
    expect(resolveChannelAccountInvocation({ accountConfig: { model: "invalid", variant: "high" } })).toEqual({})
  })
})
