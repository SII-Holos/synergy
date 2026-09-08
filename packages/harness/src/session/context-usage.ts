import type { ModelMessage } from "ai"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import type { MessageV2 } from "./message-v2"
import type { ToolResolver } from "./tool-resolver"
import { ContextUsageSchema, type ContextUsageSnapshot } from "./context-usage-schema"
import { ContextUsageEstimator } from "./context-usage-estimator"

export namespace ContextUsage {
  const CATEGORY_KEYS = ["conversation", "toolActivity", "filesReferences", "instructions"] as const
  type CategoryKey = (typeof CATEGORY_KEYS)[number]

  export const Schema = ContextUsageSchema
  export type Snapshot = ContextUsageSnapshot

  export interface DraftCategory {
    estimatedTokens: number
    items: number
  }

  export interface Draft {
    modelID: string
    providerID: string
    contextLimit?: number
    usableInputLimit?: number
    categories: Record<CategoryKey, DraftCategory>
    estimator:
      | {
          kind: "model-tokenizer"
          encoding?: string
        }
      | {
          kind: "bounded-utf8"
          sampledCharacters: number
          truncated: boolean
        }
  }

  type Contribution = MessageV2.ModelMessageContribution

  export type Provenance = MessageV2.ModelMessageProvenance

  export function remapProvenance(messages: ModelMessage[], source: Provenance): Provenance {
    const provenance = emptyProvenance()
    const sourceCategories = new Map<string, CategoryKey[]>()
    for (const key of CATEGORY_KEYS) {
      for (const contribution of source.categories[key]) {
        const categories = sourceCategories.get(contribution.text) ?? []
        categories.push(key)
        sourceCategories.set(contribution.text, categories)
      }
    }

    for (const message of messages) {
      const fallback =
        message.role === "system" ? "instructions" : message.role === "tool" ? "toolActivity" : "conversation"
      if (typeof message.content === "string") {
        addRemappedContribution(provenance, sourceCategories, fallback, message.content)
        continue
      }
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type === "text" || part.type === "reasoning") {
          addRemappedContribution(provenance, sourceCategories, fallback, part.text)
          continue
        }
        if (part.type === "tool-call") {
          addRemappedContribution(provenance, sourceCategories, "toolActivity", serializeContribution(part.input))
          continue
        }
        if (part.type === "tool-result") {
          addRemappedContribution(provenance, sourceCategories, "toolActivity", serializeToolOutput(part.output))
          continue
        }
        if (part.type === "file" || part.type === "image") provenance.items.filesReferences++
      }
    }
    return provenance
  }

  export function buildProvenance(input: {
    history: MessageV2.ModelMessageProvenance
    toolDefinitions: Pick<ToolResolver.Definition, "id" | "description" | "inputSchema">[]
    instructions?: string[]
  }): Provenance {
    const provenance: Provenance = {
      categories: {
        conversation: [...input.history.categories.conversation],
        toolActivity: [...input.history.categories.toolActivity],
        filesReferences: [...input.history.categories.filesReferences],
        instructions: [...input.history.categories.instructions],
      },
      items: { ...input.history.items },
    }
    for (const instruction of input.instructions ?? []) addContribution(provenance, "instructions", instruction)

    for (const definition of input.toolDefinitions) {
      addContribution(
        provenance,
        "toolActivity",
        JSON.stringify({
          name: definition.id,
          description: definition.description,
          inputSchema: definition.inputSchema,
        }),
      )
    }

    return provenance
  }

  export async function measureDraft(input: {
    modelID: string
    providerID: string
    limits?: ModelLimit.Info
    instructions: string[]
    provenance: Provenance
  }): Promise<Draft | undefined> {
    const contributions: Record<CategoryKey, Contribution[]> = {
      ...input.provenance.categories,
      instructions: [
        ...input.instructions.filter((text) => text.length > 0).map((text) => ({ text })),
        ...input.provenance.categories.instructions,
      ],
    }
    const request = boundedEstimatorRequest(contributions)
    const measured = await ContextUsageEstimator.estimate(request)
    if (!measured) return undefined

    const categories = emptyDraftCategories()
    for (const key of CATEGORY_KEYS) {
      categories[key] = {
        estimatedTokens: nonNegativeInteger(measured.categories[key]),
        items: nonNegativeInteger(
          input.provenance.items[key] + (key === "instructions" ? input.instructions.length : 0),
        ),
      }
    }

    const contextLimit = positiveInteger(input.limits?.context)
    const usableInputLimit = positiveInteger(ModelLimit.usableInput(input.limits))
    return {
      modelID: input.modelID,
      providerID: input.providerID,
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(usableInputLimit === undefined ? {} : { usableInputLimit }),
      categories,
      estimator: {
        kind: "bounded-utf8",
        sampledCharacters: measured.sampledCharacters,
        truncated: measured.truncated,
      },
    }
  }

  export function reconcile(draft: Draft, totalInput: number, capturedAt = Date.now()): Snapshot {
    const exactTotal = nonNegativeInteger(totalInput)
    const estimates = CATEGORY_KEYS.map((key) => nonNegativeInteger(draft.categories[key].estimatedTokens))
    const estimatedTotal = estimates.reduce((sum, tokens) => sum + tokens, 0)
    const scaledDown = estimatedTotal > exactTotal
    const factor = scaledDown && estimatedTotal > 0 ? exactTotal / estimatedTotal : 1
    const attributed = scaledDown ? largestRemainder(estimates, exactTotal) : estimates
    const attributedSum = attributed.reduce((sum, tokens) => sum + tokens, 0)

    const categories = Object.fromEntries(
      CATEGORY_KEYS.map((key, index) => [
        key,
        {
          estimatedTokens: estimates[index],
          attributedTokens: attributed[index],
          items: nonNegativeInteger(draft.categories[key].items),
        },
      ]),
    ) as Snapshot["categories"]

    return Schema.parse({
      version: 1,
      modelID: draft.modelID,
      providerID: draft.providerID,
      totalInput: exactTotal,
      ...(positiveInteger(draft.contextLimit) === undefined
        ? {}
        : { contextLimit: positiveInteger(draft.contextLimit) }),
      ...(positiveInteger(draft.usableInputLimit) === undefined
        ? {}
        : { usableInputLimit: positiveInteger(draft.usableInputLimit) }),
      categories,
      overhead: { attributedTokens: exactTotal - attributedSum },
      estimator: draft.estimator,
      reconciliation: {
        mode: scaledDown ? "scaled-down" : "residual",
        factor,
      },
      capturedAt: nonNegativeInteger(capturedAt),
    })
  }

  export function attributedTotal(snapshot: Snapshot): number {
    return (
      CATEGORY_KEYS.reduce((sum, key) => sum + snapshot.categories[key].attributedTokens, 0) +
      snapshot.overhead.attributedTokens
    )
  }

  function emptyProvenance(): Provenance {
    return {
      categories: {
        conversation: [],
        toolActivity: [],
        filesReferences: [],
        instructions: [],
      },
      items: {
        conversation: 0,
        toolActivity: 0,
        filesReferences: 0,
        instructions: 0,
      },
    }
  }

  function addRemappedContribution(
    provenance: Provenance,
    sourceCategories: Map<string, CategoryKey[]>,
    fallback: CategoryKey,
    text: string | undefined,
  ) {
    if (!text) return
    const categories = sourceCategories.get(text)
    const fallbackIndex = categories?.indexOf(fallback) ?? -1
    let category = fallback
    if (categories)
      category = fallbackIndex >= 0 ? categories.splice(fallbackIndex, 1)[0] : (categories.shift() ?? fallback)
    addContribution(provenance, category, text)
  }

  function serializeContribution(input: unknown): string | undefined {
    if (typeof input === "string") return input
    try {
      return JSON.stringify(input)
    } catch {
      return undefined
    }
  }

  function serializeToolOutput(output: unknown): string | undefined {
    if (!output || typeof output !== "object" || !("type" in output)) return serializeContribution(output)
    if (
      (output.type === "text" || output.type === "error-text") &&
      "value" in output &&
      typeof output.value === "string"
    ) {
      return output.value
    }
    if ((output.type === "json" || output.type === "error-json") && "value" in output) {
      return serializeContribution(output.value)
    }
    return serializeContribution(output)
  }

  function emptyDraftCategories(): Record<CategoryKey, DraftCategory> {
    return {
      conversation: { estimatedTokens: 0, items: 0 },
      toolActivity: { estimatedTokens: 0, items: 0 },
      filesReferences: { estimatedTokens: 0, items: 0 },
      instructions: { estimatedTokens: 0, items: 0 },
    }
  }

  function addContribution(provenance: Provenance, category: CategoryKey, text: string | undefined) {
    if (!text) return
    provenance.categories[category].push({ text })
    provenance.items[category]++
  }

  function boundedEstimatorRequest(contributions: Record<CategoryKey, Contribution[]>): ContextUsageEstimator.Request {
    const categories = Object.fromEntries(
      CATEGORY_KEYS.map((key) => [key, boundedSamples(contributions[key])]),
    ) as Record<CategoryKey, ContextUsageEstimator.Contribution[]>
    const sampledCharacters = Object.values(categories)
      .flat()
      .reduce((sum, contribution) => sum + contribution.sample.length, 0)
    const truncated = CATEGORY_KEYS.some((key) => {
      const source = contributions[key]
      const sampled = categories[key]
      return (
        source.length > sampled.length ||
        sampled.some((contribution) => contribution.sample.length < contribution.sourceCharacters)
      )
    })
    return { categories, sampledCharacters, truncated }
  }

  function boundedSamples(contributions: Contribution[]): ContextUsageEstimator.Contribution[] {
    const populated = contributions.filter((contribution) => contribution.text.length > 0)
    const count = Math.min(populated.length, ContextUsageEstimator.LIMITS.contributionsPerCategory)
    if (count === 0) return []

    const baseLimit = Math.floor(ContextUsageEstimator.LIMITS.sampleCharactersPerCategory / count)
    const remainder = ContextUsageEstimator.LIMITS.sampleCharactersPerCategory % count
    return Array.from({ length: count }, (_, index) => {
      const start = Math.floor((index * populated.length) / count)
      const end = Math.floor(((index + 1) * populated.length) / count)
      const bucket = populated.slice(start, end)
      const sourceCharacters = bucket.reduce((sum, contribution) => sum + contribution.text.length, 0)
      const limit = Math.min(
        ContextUsageEstimator.LIMITS.sampleCharactersPerContribution,
        baseLimit + (index < remainder ? 1 : 0),
      )
      return {
        sample: sampleBucket(bucket, sourceCharacters, limit),
        sourceCharacters,
      }
    })
  }

  function sampleBucket(contributions: Contribution[], sourceCharacters: number, limit: number): string {
    if (sourceCharacters <= limit) return contributions.map((contribution) => contribution.text).join("")

    const sample: string[] = []
    let contributionIndex = 0
    let contributionStart = 0
    for (let index = 0; index < limit; index++) {
      const position = Math.floor(((index + 0.5) * sourceCharacters) / limit)
      while (position >= contributionStart + contributions[contributionIndex].text.length) {
        contributionStart += contributions[contributionIndex].text.length
        contributionIndex++
      }
      sample.push(contributions[contributionIndex].text[position - contributionStart])
    }
    return sample.join("")
  }

  function largestRemainder(estimates: number[], total: number): number[] {
    if (total === 0) return estimates.map(() => 0)
    const estimatedTotal = estimates.reduce((sum, tokens) => sum + tokens, 0)
    if (estimatedTotal === 0) return estimates.map(() => 0)

    const exact = estimates.map((tokens) => (tokens * total) / estimatedTotal)
    const allocated = exact.map(Math.floor)
    let remaining = total - allocated.reduce((sum, tokens) => sum + tokens, 0)
    const order = exact
      .map((tokens, index) => ({ index, remainder: tokens - allocated[index] }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    for (const entry of order) {
      if (remaining === 0) break
      allocated[entry.index]++
      remaining--
    }
    return allocated
  }

  function nonNegativeInteger(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0
    return Math.floor(value)
  }

  function positiveInteger(value: number | undefined): number | undefined {
    const normalized = nonNegativeInteger(value)
    return normalized > 0 ? normalized : undefined
  }
}
