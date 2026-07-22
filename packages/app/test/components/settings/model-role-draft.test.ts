import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import {
  createProviderModelIndex,
  modelRoleCopy,
  resolveModelRoleDraftDisplay,
} from "../../../src/components/settings/model-role-draft"
import type { ModelsStore } from "../../../src/components/settings/types"

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

const roleMessages = {
  "settings.modelRole.fallback": "使用后备模型",
  "settings.modelRole.model.label": "默认模型",
  "settings.modelRole.miniModel.label": "迷你模型",
  "settings.modelRole.willResolveToVia": "将解析为 {model}，经由{role}",
}

const i18n = setupI18n()
i18n.loadAndActivate({ locale: "zh-CN", messages: roleMessages })
const translate = i18n._.bind(i18n)

const englishI18n = setupI18n()
englishI18n.loadAndActivate({ locale: "en", messages: {} })
const translateEnglish = englishI18n._.bind(englishI18n)

describe("model role draft display", () => {
  test("maps server role fields to localizable product copy", () => {
    expect(modelRoleCopy(summary({ field: "model", fallbackChain: ["model"] }), translate)).toEqual({
      label: "默认模型",
      description: "Primary model for conversations and agent tasks",
    })
    expect(modelRoleCopy(summary({ field: "mini_model", fallbackChain: ["mini_model"] }), translate).label).toBe(
      "迷你模型",
    )
  })

  test("preserves server copy for unknown future roles", () => {
    const serverSummary = { field: "future_model", label: "Role", summary: "Role summary" }
    expect(modelRoleCopy(serverSummary, translate)).toEqual({ label: "Role", description: "Role summary" })
  })

  test("localizes fallback resolution copy and role names", () => {
    const display = resolveModelRoleDraftDisplay(
      {
        summary: summary({
          field: "mini_model",
          fallbackChain: ["mini_model", "model"],
          resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
        }),
        value: "",
        draftModels: models({ model: "openai/gpt-5.5-mini" }),
        savedModels: models({ model: "deepseek/deepseek-v4" }),
        providerIndex,
      },
      translate,
    )

    expect(display.triggerLabel).toBe("使用后备模型")
    expect(display.triggerDetail).toBe("将解析为 GPT 5.5 Mini，经由默认模型")
  })

  test("preserves server disabled reasons verbatim", () => {
    const disabledReason = "Image analysis is disabled until a vision model is configured"
    const display = resolveModelRoleDraftDisplay(
      {
        summary: summary({
          id: "vision",
          field: "vision_model",
          fallbackChain: ["vision_model"],
          disabledReason,
        }),
        value: "",
        draftModels: models(),
        savedModels: models(),
        providerIndex,
      },
      translate,
    )

    expect(display.resolutionDescription).toBe(disabledReason)
  })

  test("shows an explicit draft model immediately", () => {
    const display = resolveModelRoleDraftDisplay(
      {
        summary: summary({
          field: "model",
          fallbackChain: ["model"],
          resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
        }),
        value: "openai/gpt-5.5",
        draftModels: models({ model: "openai/gpt-5.5" }),
        savedModels: models({ model: "deepseek/deepseek-v4" }),
        providerIndex,
      },
      translateEnglish,
    )

    expect(display.triggerLabel).toBe("GPT 5.5")
    expect(display.triggerDetail).toBe("OpenAI")
    expect(display.resolutionDescription).toBe("Will use GPT 5.5 after saving")
  })

  test("resolves fallback from draft upstream role values", () => {
    const display = resolveModelRoleDraftDisplay(
      {
        summary: summary({
          field: "mini_model",
          fallbackChain: ["mini_model", "model"],
          resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
        }),
        value: "",
        draftModels: models({ model: "openai/gpt-5.5-mini" }),
        savedModels: models({ model: "deepseek/deepseek-v4" }),
        providerIndex,
      },
      translateEnglish,
    )

    expect(display.triggerLabel).toBe("Use fallback")
    expect(display.triggerDetail).toBe("Will resolve to GPT 5.5 Mini via Default Model")
    expect(display.resolutionDescription).toBe("Will resolve to GPT 5.5 Mini via Default Model")
  })

  test("does not show stale server resolution when changed fallback cannot be resolved locally", () => {
    const display = resolveModelRoleDraftDisplay(
      {
        summary: summary({
          field: "mini_model",
          fallbackChain: ["mini_model", "model"],
          resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
        }),
        value: "",
        draftModels: models({ model: "" }),
        savedModels: models({ model: "deepseek/deepseek-v4" }),
        providerIndex,
      },
      translateEnglish,
    )

    expect(display.triggerLabel).toBe("Use fallback")
    expect(display.triggerDetail).toBe("Will resolve after saving")
    expect(display.resolutionDescription).toBe("Will resolve after saving")
  })

  test("uses saved server summary when no draft role changed", () => {
    const display = resolveModelRoleDraftDisplay(
      {
        summary: summary({
          field: "mini_model",
          fallbackChain: ["mini_model", "model"],
          resolvedModel: { ...ref("deepseek", "deepseek-v4"), via: "model" },
        }),
        value: "",
        draftModels: models({ model: "deepseek/deepseek-v4" }),
        savedModels: models({ model: "deepseek/deepseek-v4" }),
        providerIndex,
      },
      translateEnglish,
    )

    expect(display.triggerLabel).toBe("Use fallback")
    expect(display.triggerDetail).toBe("Resolves to DeepSeek V4")
    expect(display.resolutionDescription).toBe("DeepSeek V4 via Default Model")
  })
})

function summary(input: {
  id?: ModelRoleSummary["id"]
  field: ModelRoleSummary["field"]
  fallbackChain: ModelRoleSummary["fallbackChain"]
  resolvedModel?: ModelRoleSummary["resolvedModel"]
  disabledReason?: ModelRoleSummary["disabledReason"]
}): ModelRoleSummary {
  return {
    id: input.id ?? (input.field === "model" ? "default" : "mini"),
    field: input.field,
    label: "Role",
    summary: "Role summary",
    fallbackChain: input.fallbackChain,
    resolvedModel: input.resolvedModel,
    disabledReason: input.disabledReason,
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
    quick_switcher: [],
    ...overrides,
  }
}
