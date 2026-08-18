import { beforeAll, describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"
import { resolveChannelAccountInvocation, resolveChannelInvocationWithImages } from "../../src/channel/model-selection"

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

describe("channel image-aware model selection", () => {
  const TEXT_INVOCATION = { model: { providerID: "test-text", modelID: "text-model" } }
  const VISION_INVOCATION = { model: { providerID: "test-vision", modelID: "vision-model" } }

  function providerConfig() {
    type Modality = "text" | "image" | "video" | "audio" | "pdf"
    const textOnly = { input: ["text"] as Modality[], output: ["text"] as Modality[] }
    const vision = { input: ["text", "image"] as Modality[], output: ["text"] as Modality[] }
    return {
      "test-text": {
        models: {
          "text-model": {
            id: "text-model",
            name: "Text model",
            modalities: textOnly,
          },
        },
      },
      "test-vision": {
        models: {
          "vision-model": {
            id: "vision-model",
            name: "Vision model",
            modalities: vision,
          },
        },
      },
    }
  }

  // Provider state initialization for a fresh scope is expensive (~10s), so
  // share one scope across the image cases and warm it once in beforeAll.
  let scope: Awaited<ReturnType<Awaited<ReturnType<typeof tmpdir>>["scope"]>>

  beforeAll(async () => {
    const tmp = await tmpdir({
      git: true,
      config: {
        model: "test-text/text-model",
        vision_model: "test-vision/vision-model",
        provider: providerConfig(),
      },
    })
    scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: () => Provider.getModel("test-text", "text-model").then(() => undefined),
    })
  }, 30_000)

  test("switches to the configured vision model when an image arrives and the pinned model cannot consume images", async () => {
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await expect(
          resolveChannelInvocationWithImages({
            invocation: { ...TEXT_INVOCATION },
            hasImageAttachments: true,
          }),
        ).resolves.toEqual(VISION_INVOCATION)
      },
    })
  })

  test("keeps the pinned model when the message carries no image attachments", async () => {
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await expect(
          resolveChannelInvocationWithImages({
            invocation: { ...TEXT_INVOCATION },
            hasImageAttachments: false,
          }),
        ).resolves.toEqual(TEXT_INVOCATION)
      },
    })
  })

  test("keeps the pinned model when it already supports image input", async () => {
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await expect(
          resolveChannelInvocationWithImages({
            invocation: { ...VISION_INVOCATION },
            hasImageAttachments: true,
          }),
        ).resolves.toEqual(VISION_INVOCATION)
      },
    })
  })

  test("keeps the pinned model when no vision model is configured", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { model: "test-text/text-model", provider: providerConfig() },
    })
    const noVisionScope = await tmp.scope()
    await ScopeContext.provide({
      scope: noVisionScope,
      fn: async () => {
        await expect(
          resolveChannelInvocationWithImages({
            invocation: { ...TEXT_INVOCATION },
            hasImageAttachments: true,
          }),
        ).resolves.toEqual(TEXT_INVOCATION)
      },
    })
  }, 30_000)
})
