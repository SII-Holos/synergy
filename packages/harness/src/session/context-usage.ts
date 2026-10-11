import type { ModelMessage } from "ai"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { MessageV2 } from "./message-v2"
import type { ToolResolver } from "./tool-resolver"
import {
  ContextUsageSchema,
  ContextCategoryKeys,
  ContextSourceSchema,
  type ContextCategoryKey,
  type ContextUsageSnapshot,
  type ContextUsageDraft,
} from "./context-usage-schema"
import { ContextUsageEstimator } from "./context-usage-estimator"
import { reconcileContextUsage } from "./context-usage-attribution"

export namespace ContextUsage {
  const CATEGORY_KEYS = ContextCategoryKeys
  type CategoryKey = ContextCategoryKey
  export const Schema = ContextUsageSchema
  export type Snapshot = ContextUsageSnapshot
  export interface DraftCategory {
    estimatedTokens: number
    items: number
    precision?: "source" | "role"
  }
  export type Draft = ContextUsageDraft
  type Contribution = MessageV2.ModelMessageContribution
  export type Provenance = MessageV2.ModelMessageProvenance

  export function remapProvenance(messages: ModelMessage[], source: Provenance): Provenance {
    const provenance = MessageV2.createModelMessageProvenance()
    provenance.injections = source.injections
    const native = source.categories.attachments.filter((entry) => entry.nativeURL)
    const sources = new Map<string, { category: CategoryKey; contribution: Contribution }[]>()
    for (const category of CATEGORY_KEYS) {
      for (const contribution of source.categories[category]) {
        const entries = sources.get(contribution.text) ?? []
        entries.push({ category, contribution })
        sources.set(contribution.text, entries)
      }
    }
    const add = (
      text: string | undefined,
      fallback: CategoryKey,
      path: string[],
      selector: string[],
      name?: string,
    ) => {
      if (!text) return
      const entries = sources.get(text)
      const index = entries?.findIndex((entry) => entry.category === fallback) ?? -1
      const match = entries?.splice(Math.max(0, index), 1)[0]
      addContribution(provenance, match?.category ?? fallback, {
        ...match?.contribution,
        text,
        path,
        selector,
        source: match?.contribution.source ?? name ?? fallback,
        precision: match?.contribution.precision ?? "role",
      })
    }
    messages.forEach((message, index) => {
      const path = ["messages", String(index)]
      const fallback =
        message.role === "system"
          ? "systemInstructions"
          : message.role === "tool"
            ? "toolResults"
            : message.role === "assistant"
              ? "assistantMessages"
              : "userMessages"
      if (typeof message.content === "string") {
        add(message.content, fallback, path, ["content"])
        return
      }
      message.content.forEach((part, partIndex) => {
        const selector = ["content", String(partIndex)]
        if (part.type === "text" || part.type === "reasoning") add(part.text, fallback, path, [...selector, "text"])
        if (part.type === "tool-call")
          add(serializeContribution(part.input), "assistantMessages", path, [...selector, "input"], part.toolName)
        if (part.type === "tool-result")
          add(
            serializeToolOutput(part.output),
            part.toolName === "skill" ? "skills" : "toolResults",
            path,
            [...selector, "output"],
            part.toolName,
          )
        if (part.type === "file" || part.type === "image") {
          provenance.items.attachments++
          const data = part.type === "file" ? part.data : part.image
          const index = native.findIndex((entry) => entry.nativeURL === String(data))
          const match = index >= 0 ? native.splice(index, 1)[0] : undefined
          provenance.categories.attachments.push({
            ...match,
            text: "",
            path,
            selector,
            source: match?.source ?? part.type,
            precision: match?.precision ?? "role",
          })
        }
      })
    })
    return provenance
  }

  export function buildProvenance(input: {
    history: Provenance
    toolDefinitions: Pick<ToolResolver.Definition, "id" | "description" | "inputSchema">[]
    instructions?: string[]
    injections?: Provenance["injections"]
  }): Provenance {
    const provenance = MessageV2.createModelMessageProvenance()
    for (const key of CATEGORY_KEYS) provenance.categories[key] = [...input.history.categories[key]]
    provenance.items = { ...input.history.items }
    provenance.injections = input.injections ?? input.history.injections
    for (const text of input.instructions ?? [])
      addContribution(provenance, "systemInstructions", { text, precision: "source" })
    input.toolDefinitions.forEach((definition, index) =>
      addContribution(provenance, "toolDefinitions", {
        text: JSON.stringify({
          name: definition.id,
          description: definition.description,
          inputSchema: definition.inputSchema,
        }),
        path: ["tools", String(index)],
        source: definition.id,
        precision: "source",
      }),
    )
    return provenance
  }

  function instructionContributions(instructions: string[], provenance: Provenance, field: string) {
    const result: { category: CategoryKey; contribution: Contribution }[] = []
    instructions.forEach((text, index) => {
      const matches = (provenance.injections ?? [])
        .flatMap((entry) => {
          if (!entry.text) return []
          const start = text.indexOf(entry.text)
          return start < 0 ? [] : [{ ...entry, start, end: start + entry.text.length }]
        })
        .sort((a, b) => a.start - b.start || b.end - a.end)
      const add = (start: number, end: number, category: CategoryKey, source: string) => {
        if (end <= start) return
        result.push({
          category,
          contribution: {
            text: text.slice(start, end),
            path: [field, String(index)],
            source,
            precision: "source",
            ...(start || end !== text.length ? { range: { start, end } } : {}),
          },
        })
      }
      let cursor = 0
      for (const match of matches) {
        if (match.start < cursor) continue
        add(cursor, match.start, "systemInstructions", "system")
        add(match.start, match.end, "injectedContext", match.source)
        cursor = match.end
      }
      add(cursor, text.length, "systemInstructions", "system")
    })
    return result
  }

  export function sourceIndex(input: {
    messages: ModelMessage[]
    system: string[]
    lateSystem?: string[]
    provenance: Provenance
  }) {
    const history = remapProvenance(input.messages, input.provenance)
    const sources = CATEGORY_KEYS.flatMap((category) => {
      const contributions =
        category === "toolDefinitions" ? input.provenance.categories[category] : history.categories[category]
      return contributions
        .filter((entry) => entry.path)
        .map((entry) =>
          ContextSourceSchema.parse({
            category,
            path: entry.path,
            selector: entry.selector,
            range: entry.range,
            source: entry.source ?? category,
            messageID: entry.messageID,
            partID: entry.partID,
            characters: entry.text.length,
            precision: entry.precision ?? "role",
          }),
        )
    })
    for (const { category, contribution } of [
      ...instructionContributions(input.system, input.provenance, "system"),
      ...instructionContributions(input.lateSystem ?? [], input.provenance, "lateSystem"),
    ])
      sources.push(ContextSourceSchema.parse({ category, ...contribution, characters: contribution.text.length }))
    return sources
  }

  export async function measureDraft(input: {
    sessionID?: string
    modelID: string
    providerID: string
    limits?: ModelLimit.Info
    instructions: string[]
    provenance: Provenance
  }): Promise<Draft | undefined> {
    const contributions = Object.fromEntries(
      CATEGORY_KEYS.map((key) => [key, [...input.provenance.categories[key]]]),
    ) as Record<CategoryKey, Contribution[]>
    const items = { ...input.provenance.items }
    for (const { category, contribution } of instructionContributions(input.instructions, input.provenance, "system")) {
      contributions[category].push(contribution)
      items[category]++
    }
    const measured = await ContextUsageEstimator.estimate(
      boundedEstimatorRequest(contributions),
      input.sessionID
        ? { sessionID: input.sessionID, providerID: input.providerID, modelID: input.modelID }
        : undefined,
    )
    if (!measured) return undefined
    return {
      modelID: input.modelID,
      providerID: input.providerID,
      contextLimit: positiveInteger(input.limits?.context),
      usableInputLimit: positiveInteger(ModelLimit.usableInput(input.limits)),
      categories: Object.fromEntries(
        CATEGORY_KEYS.map((key) => [
          key,
          {
            estimatedTokens: nonNegativeInteger(measured.categories[key]),
            items: nonNegativeInteger(items[key]),
            ...(contributions[key].some((entry) => entry.precision === "role") ? { precision: "role" as const } : {}),
          },
        ]),
      ) as Draft["categories"],
      estimator: { kind: "bounded-utf8", sampledCharacters: measured.sampledCharacters, truncated: measured.truncated },
    }
  }

  export const reconcile = reconcileContextUsage

  export function attributedTotal(snapshot: Snapshot): number {
    return snapshot.categories.reduce(
      (sum, category) => sum + category.attributedTokens,
      snapshot.overhead.attributedTokens,
    )
  }
  function addContribution(provenance: Provenance, category: CategoryKey, contribution: Contribution) {
    if (!contribution.text) return
    provenance.categories[category].push(contribution)
    provenance.items[category]++
  }
  function serializeContribution(value: unknown): string | undefined {
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value)
    } catch {
      return undefined
    }
  }
  function serializeToolOutput(output: unknown): string | undefined {
    if (output && typeof output === "object" && "value" in output) return serializeContribution(output.value)
    return serializeContribution(output)
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

  function nonNegativeInteger(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0
    return Math.floor(value)
  }

  function positiveInteger(value: number | undefined): number | undefined {
    const normalized = nonNegativeInteger(value)
    return normalized > 0 ? normalized : undefined
  }
}
