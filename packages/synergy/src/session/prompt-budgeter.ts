import type { JSONSchema7, ModelMessage } from "ai"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { Plugin } from "@/plugin"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"
import { ToolResolver } from "./tool-resolver"

export namespace PromptBudgeter {
  const DEFAULT_OVERFLOW_THRESHOLD = 0.85
  const TOOL_OVERHEAD_PER_TOOL = 48
  const MESSAGE_OVERHEAD_PER_ITEM = 12

  export interface PromptPlanInput {
    model: Provider.Model
    system: string[]
    messages: ModelMessage[]
    toolDefinitions: ToolResolver.Definition[]
  }

  export interface PromptPlan {
    system: string[]
    messages: ModelMessage[]
    toolDefinitions: ToolResolver.Definition[]
  }

  export interface Budget {
    context: number
    usable: number
    threshold: number
    soft: number
  }

  export interface Measure {
    system: number
    messages: number
    tools: number
    total: number
  }

  export interface Decision {
    budget: Budget
    measure: Measure
    shouldCompact: boolean
  }

  export async function buildPlan(input: PromptPlanInput): Promise<PromptPlan> {
    const system = [...input.system]
    const original = [...system]
    await Plugin.trigger("experimental.chat.system.transform", {}, { system })
    const normalizedSystem = system.length > 0 ? system : original

    return {
      system: normalizedSystem,
      messages: ProviderTransform.message(input.messages, input.model),
      toolDefinitions: input.toolDefinitions,
    }
  }

  export function budget(
    limits: ModelLimit.Info | undefined,
    options?: {
      overflowThreshold?: number
    },
  ): Budget {
    const context = limits?.context ?? 0
    const usable = ModelLimit.usableInput(limits)
    const threshold = options?.overflowThreshold ?? DEFAULT_OVERFLOW_THRESHOLD
    return {
      context,
      usable,
      threshold,
      soft: Math.floor(usable * threshold),
    }
  }

  export async function measure(plan: PromptPlan, modelID: string): Promise<Measure> {
    await Token.warmup(modelID)
    const systemCost = await Token.estimateModelJSON(
      modelID,
      plan.system.map((content) => ({ role: "system", content })),
    )
    const messageCost = await Token.estimateModelJSON(modelID, plan.messages)
    const toolCost = await estimateTools(plan.toolDefinitions, modelID)
    return {
      system: systemCost,
      messages: messageCost,
      tools: toolCost,
      total: systemCost + messageCost + toolCost,
    }
  }

  export async function decide(
    plan: PromptPlan,
    limits: ModelLimit.Info | undefined,
    modelID: string,
    options?: {
      overflowThreshold?: number
    },
  ): Promise<Decision> {
    const resultBudget = budget(limits, options)
    const resultMeasure = await measure(plan, modelID)
    return {
      budget: resultBudget,
      measure: resultMeasure,
      shouldCompact: resultBudget.usable > 0 && resultMeasure.total >= resultBudget.soft,
    }
  }

  async function estimateTools(defs: ToolResolver.Definition[], modelID: string) {
    let total = 0
    for (const item of defs) {
      total += TOOL_OVERHEAD_PER_TOOL
      total += await Token.estimateModel(modelID, item.id)
      total += await Token.estimateModel(modelID, item.description)
      total += await estimateSchema(modelID, item.inputSchema)
    }
    return total
  }

  async function estimateSchema(modelID: string, schema: JSONSchema7) {
    return (await Token.estimateModelJSON(modelID, schema)) + MESSAGE_OVERHEAD_PER_ITEM
  }
}
