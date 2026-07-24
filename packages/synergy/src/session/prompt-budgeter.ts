import type { JSONSchema7, ModelMessage } from "ai"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { Plugin } from "@/plugin"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"
import { Log } from "@/util/log"
import { ToolResolver } from "./tool-resolver"

export namespace PromptBudgeter {
  const log = Log.create({ service: "prompt-budgeter" })
  const DEFAULT_OVERFLOW_THRESHOLD = 0.85
  const TOOL_OVERHEAD_PER_TOOL = 48
  const MESSAGE_OVERHEAD_PER_ITEM = 12
  const ESTIMATE_CACHE_MAX = 4096
  const estimateCache = new Map<string, number>()

  export interface PromptPlanInput {
    sessionID: string
    agent: string
    messageID?: string
    model: Provider.Model
    system: string[]
    systemCacheBreakpoint?: number
    lateSystem?: string[]
    messages: ModelMessage[]
    toolDefinitions: ToolResolver.Definition[]
  }

  export interface PromptPlan {
    system: string[]
    systemCacheBreakpoint?: number
    lateSystem?: string[]
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

  /**
   * Calibration data from a previous API call in the same invoke loop.
   *
   * The API reports real token counts using the model's native tokenizer.
   * `actualInput` covers the full prompt (system + messages + tools) as of
   * that call. `outputTokens` is the response length, which becomes part of
   * the conversation history in subsequent calls. Together they let us
   * estimate the next call's cost with far better accuracy than re-tokenizing
   * everything through a mismatched tokenizer (e.g. o200k_base for Claude).
   */
  export interface Calibration {
    actualInput: number
    outputTokens: number
    deltaTokens: number
  }

  export async function buildPlan(input: PromptPlanInput): Promise<PromptPlan> {
    const original = [...input.system]
    const transformed = await Plugin.trigger(
      "experimental.chat.system.transform",
      {
        phase: "budget",
        sessionID: input.sessionID,
        agent: input.agent,
        model: { providerID: input.model.providerID, modelID: input.model.id },
        messageID: input.messageID,
        system: original,
      },
      { system: original },
    )
    const normalizedSystem = transformed.system.length > 0 ? transformed.system : original
    log.debug("system transform budget result", {
      sessionID: input.sessionID,
      ...(input.messageID ? { messageID: input.messageID } : {}),
      agent: input.agent,
      model: { providerID: input.model.providerID, modelID: input.model.id },
      beforeSystemCount: original.length,
      afterSystemCount: normalizedSystem.length,
      restoredEmptySystem: transformed.system.length === 0,
    })

    const lateSystem = [...(input.lateSystem ?? [])]
    return {
      system: normalizedSystem,
      systemCacheBreakpoint: normalizeCacheBreakpoint(input.systemCacheBreakpoint, normalizedSystem.length),
      lateSystem,
      messages: ProviderTransform.message(input.messages, input.model, {
        lookAtAvailable: input.toolDefinitions.some((tool) => tool.id === "look_at"),
        viewImageAvailable: input.toolDefinitions.some((tool) => tool.id === "view_image"),
      }),
      toolDefinitions: input.toolDefinitions,
    }
  }

  function normalizeCacheBreakpoint(index: number | undefined, length: number): number | undefined {
    if (index === undefined || length === 0) return undefined
    if (!Number.isInteger(index) || index < 0) return undefined
    return Math.min(index, length - 1)
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

  /**
   * Estimated visual tokens per image/file for budgeter purposes.
   *
   * Text tokenizers (tiktoken) count base64 bytes as text tokens, massively
   * overcounting the real cost — providers charge by visual tokens (typically
   * 85–1000 per image depending on resolution and provider). This fixed
   * estimate is intentionally conservative to avoid false-positive
   * compactions while still catching genuine overflows from many images.
   */
  const IMAGE_TOKEN_ESTIMATE = 500

  /**
   * Sanitize ModelMessage content for token estimation by replacing
   * base64 data URLs with short placeholders. Text tokenizers cannot
   * distinguish binary data from natural language and would count every
   * base64 character as a text token, producing wildly inflated counts.
   */
  function sanitizeForEstimation(msgs: ModelMessage[]) {
    let imageParts = 0
    const sanitized = msgs.map((msg) => ({
      ...msg,
      content: Array.isArray(msg.content)
        ? msg.content.map((part: any) => {
            if (part.type === "image") {
              imageParts++
              return { ...part, image: "[image]" }
            }
            if (part.type === "file") {
              imageParts++
              return { ...part, data: "[file data]", mediaType: part.mediaType }
            }
            return part
          })
        : msg.content,
    }))
    return { sanitized, imageParts }
  }

  export async function measure(plan: PromptPlan, modelID: string): Promise<Measure> {
    await Token.warmup(modelID)
    const systemCost = await estimateModelJSONCached(
      modelID,
      [...plan.system, ...(plan.lateSystem ?? [])].map((content) => ({ role: "system", content })),
    )
    const messageCost = await estimateMessages(plan.messages, modelID)
    const toolCost = await estimateTools(plan.toolDefinitions, modelID)
    return {
      system: systemCost,
      messages: messageCost,
      tools: toolCost,
      total: systemCost + messageCost + toolCost,
    }
  }

  async function estimateMessages(messages: ModelMessage[], modelID: string) {
    let total = 0
    for (const message of messages) {
      const { sanitized, imageParts } = sanitizeForEstimation([message])
      total += (await estimateModelJSONCached(modelID, sanitized)) + imageParts * IMAGE_TOKEN_ESTIMATE
    }
    return total
  }

  async function estimateModelJSONCached(modelID: string, value: unknown) {
    const serialized = serializeForEstimate(value)
    if (serialized === undefined) return 0
    const key = estimateKey(modelID, serialized)
    const cached = estimateCache.get(key)
    if (cached !== undefined) return cached
    const estimated = await Token.estimateModelJSON(modelID, serialized)
    estimateCache.set(key, estimated)
    if (estimateCache.size > ESTIMATE_CACHE_MAX) {
      const first = estimateCache.keys().next().value
      if (first) estimateCache.delete(first)
    }
    return estimated
  }

  function serializeForEstimate(value: unknown): string | undefined {
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value)
    } catch {
      return undefined
    }
  }

  function estimateKey(modelID: string, serialized: string) {
    // A cache key needs a fast non-cryptographic hash, not SHA-256. Bun.hash
    // (wyhash) is ~10x faster; collisions are irrelevant at this cache size and
    // would only yield a slightly-off token estimate that calibration corrects.
    return `${modelID}\0${Bun.hash(serialized)}`
  }

  export async function decide(
    plan: PromptPlan,
    limits: ModelLimit.Info | undefined,
    modelID: string,
    options?: {
      overflowThreshold?: number
      calibration?: Calibration
    },
  ): Promise<Decision> {
    const resultBudget = budget(limits, options)

    if (options?.calibration && options.calibration.actualInput > 0) {
      const { actualInput, outputTokens, deltaTokens } = options.calibration
      const calibratedTotal = actualInput + outputTokens + deltaTokens
      return {
        budget: resultBudget,
        measure: { system: 0, messages: calibratedTotal, tools: 0, total: calibratedTotal },
        shouldCompact: resultBudget.usable > 0 && calibratedTotal >= resultBudget.soft,
      }
    }

    const resultMeasure = await measure(plan, modelID)
    return {
      budget: resultBudget,
      measure: resultMeasure,
      shouldCompact: resultBudget.usable > 0 && resultMeasure.total >= resultBudget.soft,
    }
  }

  async function estimateTools(defs: ToolResolver.Definition[], modelID: string) {
    const results = await Promise.all(
      defs.map(async (item) => {
        const [idTokens, descTokens, schemaTokens] = await Promise.all([
          Token.estimateModel(modelID, item.id),
          Token.estimateModel(modelID, item.description),
          estimateSchema(modelID, item.inputSchema),
        ])
        return TOOL_OVERHEAD_PER_TOOL + idTokens + descTokens + schemaTokens
      }),
    )
    return results.reduce((sum, n) => sum + n, 0)
  }

  async function estimateSchema(modelID: string, schema: JSONSchema7) {
    return (await estimateModelJSONCached(modelID, schema)) + MESSAGE_OVERHEAD_PER_ITEM
  }
}
