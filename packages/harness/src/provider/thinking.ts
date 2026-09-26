import { NamedError } from "@ericsanchezok/synergy-util/error"
import { z } from "zod"
import { mergeDeep } from "remeda"
import type { Provider } from "./provider"
import { ProviderModelVariantUnavailableError } from "./model-variant-unavailable-error"
import type { ModelSelection } from "../session/model-selection-schema"

export namespace ProviderThinking {
  export const UnavailableError = NamedError.create(
    "SessionThinkingUnavailableError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      mode: z.string(),
    }),
  )

  // Provenance: https://api-docs.deepseek.com/guides/thinking_mode/
  // Local adaptation: expose disabled thinking only when the model catalog and transport support its wire mapping.
  export function offOptions(model: Provider.Model): Record<string, unknown> | undefined {
    if (!model.capabilities.reasoning) return
    const declarations = model.capabilities.reasoningOptions ?? []
    const toggle = declarations.some((option) => option.type === "toggle")
    const efforts = model.capabilities.reasoningEfforts ?? []
    const none =
      efforts.includes("none") ||
      declarations.some((option) => option.type === "effort" && option.values?.includes(null))
    const sdk = model.api.npm
    const id = model.api.id.toLowerCase()
    if (sdk === "@ai-sdk/openai-compatible" && id.includes("deepseek") && toggle)
      return { thinking: { type: "disabled" } }
    if (none && ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/openai-compatible"].includes(sdk))
      return { reasoningEffort: "none" }
    if (sdk === "@openrouter/ai-sdk-provider" && (toggle || none)) return { reasoning: { enabled: false } }
    if (sdk === "@ai-sdk/anthropic" && id.includes("claude") && toggle) return { thinking: { type: "disabled" } }
    if (
      ["@ai-sdk/google", "@ai-sdk/google-vertex"].includes(sdk) &&
      id.includes("gemini") &&
      toggle &&
      declarations.some((option) => option.type === "budget" && option.min === 0)
    )
      return { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } }
  }

  export function options(model: Provider.Model, thinking: ModelSelection.Thinking): Record<string, unknown> {
    if (thinking.mode === "provider-default") return {}
    if (thinking.mode === "off") {
      const options = model.variants?.off
      if (options) return options
      throw new UnavailableError({ providerID: model.providerID, modelID: model.id, mode: thinking.mode })
    }
    const options = Object.hasOwn(model.variants ?? {}, thinking.variant)
      ? model.variants![thinking.variant]
      : undefined
    if (options) return options
    throw new ProviderModelVariantUnavailableError({
      providerID: model.providerID,
      modelID: model.id,
      variant: thinking.variant,
      availableVariants: Object.keys(model.variants ?? {}),
    })
  }

  const fields = new Set([
    "thinking",
    "thinkingConfig",
    "reasoning",
    "reasoningConfig",
    "reasoningEffort",
    "reasoning_effort",
    "effort",
    "thinkingBudget",
    "thinkingLevel",
    "includeThoughts",
    "enableThinking",
    "enable_thinking",
    "thinking_budget",
    "reasoningSummary",
    "reasoning_summary",
  ])

  export function normalize(
    model: Provider.Model,
    thinking: ModelSelection.Thinking,
    options: Record<string, unknown>,
  ) {
    const clean = Object.fromEntries(Object.entries(options).filter(([key]) => !fields.has(key)))
    if (Array.isArray(clean.include)) {
      const include = clean.include.filter((item) => item !== "reasoning.encrypted_content")
      if (include.length) clean.include = include
      else delete clean.include
    }
    return mergeDeep(clean, ProviderThinking.options(model, thinking))
  }

  export function mode(model: Provider.Model, thinking: ModelSelection.Thinking) {
    const options = ProviderThinking.options(model, thinking)
    const value = options.thinking
    return value && typeof value === "object" && "type" in value ? value.type : "default"
  }
}
