import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { ExperienceRecall } from "../engram/experience-recall"
import { EngramDB } from "../engram/database"
import { MemoryRecall } from "../engram/memory-recall"
import { Embedding } from "../engram/embedding"
import { Config } from "../config/config"

const log = Log.create({ service: "session.recall" })

export interface InjectionInfo {
  memory?: string
  experience?: string
}

export const RECALL_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Session-level recall cache
// ---------------------------------------------------------------------------

const recallCache = new Map<string, { context: string; injection: InjectionInfo }>()

export function cacheResult(sessionID: string, result: { context: string; injection: InjectionInfo }) {
  recallCache.set(sessionID, result)
}

export function getCachedResult(sessionID: string): { context: string; injection: InjectionInfo } | undefined {
  return recallCache.get(sessionID)
}

export function evictRecallCache(sessionID: string) {
  recallCache.delete(sessionID)
}

export async function buildMemoryContext(
  sessionID: string,
  scopeID: string,
  messages: MessageV2.WithParts[],
  evo: Config.ResolvedEvolution,
): Promise<{ context: string; injection: InjectionInfo } | undefined> {
  const userText = extractLastUserText(messages)
  const parts: string[] = []
  const injection: InjectionInfo = {}

  const queryEmbedding = userText
    ? await Embedding.generate({ id: "search-query", text: userText }).catch(() => undefined)
    : undefined

  const [memoryResult, experienceResult] = await Promise.all([
    evo.active ? buildActiveMemoryContext(userText, evo.activeRetrieval, queryEmbedding?.vector) : undefined,
    evo.retrieve
      ? buildExperienceContext(sessionID, scopeID, userText, evo.learning, queryEmbedding?.vector)
      : undefined,
  ])

  if (memoryResult) {
    if (memoryResult.context) parts.push(memoryResult.context)
    if (memoryResult.memoryBlock) injection.memory = memoryResult.memoryBlock
  }

  if (experienceResult?.context) {
    parts.push(experienceResult.context)
    injection.experience = experienceResult.context
  }

  return parts.length > 0 ? { context: parts.join("\n\n"), injection } : undefined
}

function extractLastUserText(messages: MessageV2.WithParts[]): string | undefined {
  const lastUserMsg = messages.findLast((m) => m.info.role === "user")
  if (!lastUserMsg) return undefined
  const text = lastUserMsg.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
  return text.trim() || undefined
}

const CATEGORY_INSTRUCTIONS: Record<EngramDB.Memory.Category, string> = {
  user: "Stable facts about the user — identity, background, responsibilities, and enduring context.",
  self: "Your persistent identity, role, and operating commitments. Stay aligned with this self-knowledge.",
  relationship: "Established collaboration patterns and expectations between you and the user. Use these as defaults.",
  interaction: "Preferred communication style, tone, language, pacing, and interaction norms for working together.",
  workflow:
    "Recurring ways of working, process expectations, and execution habits that shape how tasks should be handled.",
  coding: "Engineering conventions, codebase habits, debugging patterns, and technical preferences for coding work.",
  writing:
    "Writing preferences, editorial standards, voice, and document expectations for drafting or revising content.",
  asset: "Important resources, accounts, tools, environments, and external assets available for future work.",
  insight: "Transferable patterns in how the user thinks, decides, and evaluates tradeoffs. Use to anticipate needs.",
  knowledge: "Specific factual knowledge, project conventions, and learned lessons that apply in relevant contexts.",
  personal: "Personal details, interests, and life context that may matter occasionally but should stay non-intrusive.",
  general: "Other durable information worth preserving when it does not fit a more specific category.",
}

function formatCategorySection(category: EngramDB.Memory.Category, entries: string[]): string {
  return `<category name="${category}" instruction="${CATEGORY_INSTRUCTIONS[category]}">\n${entries.join("\n")}\n</category>`
}

function formatStoredMemoryEntry(entry: EngramDB.Memory.Row): string {
  return `<entry title="${entry.title}">\n${entry.content}\n</entry>`
}

function formatRetrievedMemoryEntry(entry: MemoryRecall.Result): string {
  return `<entry title="${entry.title}" similarity="${entry.similarity.toFixed(3)}">\n${entry.content}\n</entry>`
}

function renderMemoryBlock(groupedEntries: Map<EngramDB.Memory.Category, string[]>): string | undefined {
  const sections = [...groupedEntries.entries()]
    .filter(([, entries]) => entries.length > 0)
    .map(([category, entries]) => formatCategorySection(category, entries))
  if (sections.length === 0) return undefined
  return ["<active-memory>", ...sections, "</active-memory>"].join("\n")
}

function groupAlwaysRows(): Map<EngramDB.Memory.Category, string[]> {
  const grouped = new Map<EngramDB.Memory.Category, string[]>()
  for (const row of EngramDB.Memory.list({ recallModes: ["always"] })) {
    const items = grouped.get(row.category) ?? []
    items.push(formatStoredMemoryEntry(row))
    grouped.set(row.category, items)
  }
  return grouped
}

const MEMORY_USAGE_HINT = [
  "## Long-Term Memory",
  "",
  "Only memories marked `always` are injected every session, and only `contextual` memories are auto-retrieved semantically. Memories marked `search_only` are never auto-injected. Use `memory_search` when you need more context:",
  "",
  "- `memory_search`: Search for relevant memories by semantic similarity across long-term memory. Returns matching memory IDs and titles.",
  "- `memory_get`: Retrieve the full content of specific memories by ID.",
  "",
  "When to search memory:",
  "- Before making architectural or workflow decisions — check for established patterns or prior decisions",
  "- When entering an unfamiliar coding or writing context — past sessions may contain relevant conventions",
  "- When debugging or investigating recurring issues — similar situations may already be documented",
  "- When you need to recall assets, knowledge, or personal context that was not auto-injected",
  "",
  "Be selective — don't search memory for every trivial task. Use it when past context would genuinely improve your response.",
].join("\n")

// ---------------------------------------------------------------------------
// Always-only memory context — lightweight injection for child sessions
// ---------------------------------------------------------------------------

export function buildAlwaysOnlyMemoryContext(): string | undefined {
  const grouped = groupAlwaysRows()
  const block = renderMemoryBlock(grouped)
  if (!block) return undefined
  return [block, MEMORY_USAGE_HINT].join("\n\n")
}

async function buildActiveMemoryContext(
  userText: string | undefined,
  activeRetrieval: Config.ActiveRetrieval,
  queryVector?: number[],
): Promise<{ context: string; memoryBlock?: string }> {
  const parts: string[] = []
  const categories = Object.keys(activeRetrieval.categories) as EngramDB.Memory.Category[]
  const groupedEntries = groupAlwaysRows()

  const appendEntry = (category: EngramDB.Memory.Category, entry: string) => {
    const items = groupedEntries.get(category) ?? []
    items.push(entry)
    groupedEntries.set(category, items)
  }

  if (activeRetrieval.enabled && userText) {
    try {
      const vector = queryVector ?? (await Embedding.generate({ id: "search-query", text: userText })).vector
      const contextualResults = await Promise.all(
        categories.map(async (category) => {
          const config = activeRetrieval.categories[category]
          const results = await MemoryRecall.search({
            query: userText,
            vector,
            topK: config.topK,
            categories: [category],
            recallModes: ["contextual"],
          })
          const filtered = results.filter((result) => result.similarity >= config.simThreshold)
          if (filtered.length > 0) {
            const maxSim = Math.max(...filtered.map((r) => r.similarity))
            if (maxSim < 0.5) return []
          }
          return filtered
        }),
      )

      for (const result of contextualResults.flat()) {
        appendEntry(result.category, formatRetrievedMemoryEntry(result))
      }
    } catch (err: any) {
      log.error("active memory semantic retrieval failed", { error: err?.message ?? String(err) })
    }
  }

  const memoryBlock = renderMemoryBlock(groupedEntries)
  if (memoryBlock) parts.push(memoryBlock)

  parts.push(MEMORY_USAGE_HINT)

  return { context: parts.join("\n\n"), memoryBlock }
}

async function buildExperienceContext(
  sessionID: string,
  scopeID: string,
  userText: string | undefined,
  learning: Required<Config.Learning>,
  queryVector?: number[],
): Promise<{ context: string | undefined }> {
  if (!userText) return { context: undefined }

  try {
    const results = await ExperienceRecall.retrieve(scopeID, userText, { vector: queryVector })
    if (results.length === 0) return { context: undefined }

    const withScript = results.filter((r) => r.script)
    if (withScript.length === 0) return { context: undefined }

    ExperienceRecall.trackRetrieval(
      sessionID,
      withScript.map((r) => r.id),
    )

    const entries = withScript.map((r) => {
      const parts = [`<experience sim="${r.similarity.toFixed(3)}" q="${r.qValue.toFixed(3)}">`]
      parts.push(`<intent>${r.intent}</intent>`)
      parts.push(`<script>${r.script}</script>`)
      const evaluation = ExperienceRecall.buildEvaluation(r.rewards, learning.snapThreshold)
      if (evaluation) parts.push(`<evaluation>${evaluation}</evaluation>`)
      parts.push("</experience>")
      return parts.join("\n")
    })

    const injected = [
      "<experience-context>",
      "Past experiences with similar intent. Learn from positive patterns and avoid negative ones.",
      "",
      ...entries,
      "</experience-context>",
    ].join("\n")

    ExperienceRecall.writeDebugLog(sessionID, scopeID, userText, results, injected)

    return { context: injected }
  } catch (err: any) {
    log.error("memory retrieval failed", { error: err?.message ?? String(err) })
    return { context: undefined }
  }
}
