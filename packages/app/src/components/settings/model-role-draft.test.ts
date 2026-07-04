import { describe, expect, test } from "bun:test"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { createProviderModelIndex, resolveModelRoleDraftDisplay } from "./model-role-draft"
import type { ModelsStore } from "./types"

const providers = [
  {
    providerId: "openai",
    providerName: "OpenAI",
    models: [
      { id: "gpt-5.5", name: "GPT 5.5", variantKeys: [] },
      { id: "gpt-5.5-mini", name: "GPT 5.5 Mini", variantKeys: [] },
    ],
  },
  {
    providerId: "deepseek",
    providerName: "DeepSeek",
    models: [{ id: "deepseek-v4", name: "DeepSeek V4", variantKeys: [] }],
  },
]

const providerIndex = createProviderModelIndex(providers)

describe("model role draft display", () => {
  test("shows an explicit draft model immediately", () => {
    const display = resolveModelRoleDraftDisplay({
      summary: summary({
        field: "model",
        fallbackChain: ["model"],
        resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
      }),
      value: "openai/gpt-5.5",
      draftModels: models({ model: "openai/gpt-5.5" }),
      savedModels: models({ model: "deepseek/deepseek-v4" }),
      providerIndex,
    })

    expect(display.triggerLabel).toBe("GPT 5.5")
    expect(display.triggerDetail).toBe("OpenAI")
    expect(display.resolutionDescription).toBe("Will use GPT 5.5 after saving")
  })

  test("resolves fallback from draft upstream role values", () => {
    const display = resolveModelRoleDraftDisplay({
      summary: summary({
        field: "mini_model",
        fallbackChain: ["mini_model", "model"],
        resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
      }),
      value: "",
      draftModels: models({ model: "openai/gpt-5.5-mini" }),
      savedModels: models({ model: "deepseek/deepseek-v4" }),
      providerIndex,
    })

    expect(display.triggerLabel).toBe("Use fallback")
    expect(display.triggerDetail).toBe("Will resolve to GPT 5.5 Mini via Default")
    expect(display.resolutionDescription).toBe("Will resolve to GPT 5.5 Mini via Default")
  })

  test("does not show stale server resolution when changed fallback cannot be resolved locally", () => {
    const display = resolveModelRoleDraftDisplay({
      summary: summary({
        field: "mini_model",
        fallbackChain: ["mini_model", "model"],
        resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
      }),
      value: "",
      draftModels: models({ model: "" }),
      savedModels: models({ model: "deepseek/deepseek-v4" }),
      providerIndex,
    })

    expect(display.triggerLabel).toBe("Use fallback")
    expect(display.triggerDetail).toBe("Will resolve after saving")
    expect(display.resolutionDescription).toBe("Will resolve after saving")
  })

  test("uses saved server summary when no draft role changed", () => {
    const display = resolveModelRoleDraftDisplay({
      summary: summary({
        field: "mini_model",
        fallbackChain: ["mini_model", "model"],
        resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
      }),
      value: "",
      draftModels: models({ model: "deepseek/deepseek-v4" }),
      savedModels: models({ model: "deepseek/deepseek-v4" }),
      providerIndex,
    })

    expect(display.triggerLabel).toBe("Use fallback")
    expect(display.triggerDetail).toBe("Resolves to DeepSeek V4")
    expect(display.resolutionDescription).toBe("DeepSeek V4 via Default")
  })
})

function summary(input: {
  field: ModelRoleSummary["field"]
  fallbackChain: ModelRoleSummary["fallbackChain"]
  resolvedModel?: ModelRoleSummary["resolvedModel"]
}): ModelRoleSummary {
  return {
    id: input.field === "model" ? "default" : "mini",
    field: input.field,
    label: "Role",
    summary: "Role summary",
    fallbackChain: input.fallbackChain,
    resolvedModel: input.resolvedModel,
    usedBy: [],
  }
}

function ref(providerID: string, modelID: string) {
  return { providerID, modelID }
}

function models(overrides: Partial<ModelsStore> = {}): ModelsStore {
  return {
    model: "",
    nano_model: "",
    mini_model: "",
    mid_model: "",
    vision_model: "",
    thinking_model: "",
    long_context_model: "",
    creative_model: "",
    ...overrides,
  }
}
