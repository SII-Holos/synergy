import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { SessionLibraryRecall } from "./library-recall"
import { Embedding } from "../vector/embedding"
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
  library?: {
    memory?: {
      enabled?: boolean
      retrieval?: {
        simThreshold?: number
        topK?: number
        categories?: Record<string, { simThreshold?: number; topK?: number }>
      }
    }
    experience?: {
      retrieve?: unknown
      learning?: Config.Learning
    }
  },
): Promise<{ context: string; injection: InjectionInfo } | undefined> {
  const userText = extractLastUserText(messages)
  const parts: string[] = []
  const injection: InjectionInfo = {}

  const queryEmbedding = userText
    ? await Embedding.generate({ id: "search-query", text: userText }).catch(() => undefined)
    : undefined

  const memory = library?.memory
  const experience = library?.experience
  const active = memory?.enabled ?? true
  const retrieve = experience?.retrieve !== false
  const activeRetrieval = resolveActiveRetrieval(memory?.retrieval)
  const learning = resolveLearning(experience?.learning)

  const [memoryResult, experienceResult] = await Promise.all([
    active ? buildActiveMemoryContext(userText, activeRetrieval, queryEmbedding?.vector) : undefined,
    retrieve ? buildExperienceContext(sessionID, scopeID, userText, learning, queryEmbedding?.vector) : undefined,
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
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !MessageV2.isSystemPart(p))
    .map((p) => p.text)
    .join("\n")
  return text.trim() || undefined
}

const CATEGORY_INSTRUCTIONS: Record<SessionLibraryRecall.MemoryCategory, string> = {
  user: "Stable facts about the user — identity, background, responsibilities, and enduring context.",
  self: "Your persistent identity, role, and operating commitments. Stay aligned with this self-knowledge.",
  relationship: "Established collaboration patterns and expectations between you and the user. Use these as defaults.",
  interaction: "Preferred communication style, tone, language, pacing, and interaction norms for working together.",
  workflow:
    "Recurring ways of working, process expectations, and execution habits that shape how tasks should be handled.",
  coding: "Engineering conventions, codebase habits, debugging patterns, and technical preferences for coding work.",
  writing: "Writing preferences, editorial standards, voice, and document expectations for drafting or revising text.",
  asset: "Important resources, accounts, tools, environments, and external assets available for future work.",
  insight: "Transferable patterns in how the user thinks, decides, and evaluates tradeoffs. Use to anticipate needs.",
  knowledge: "Specific factual knowledge, project conventions, and learned lessons that apply in relevant contexts.",
  personal: "Personal details, interests, and life context that may matter occasionally but should stay non-intrusive.",
  general: "Other durable information worth preserving when it does not fit a more specific category.",
}

function formatCategorySection(category: SessionLibraryRecall.MemoryCategory, entries: string[]): string {
  return `<category name="${category}" instruction="${CATEGORY_INSTRUCTIONS[category]}">\n${entries.join("\n")}\n</category>`
}

function formatStoredMemoryEntry(entry: SessionLibraryRecall.StoredMemoryRow): string {
  return `<entry title="${entry.title}">\n${entry.content}\n</entry>`
}

function formatRetrievedMemoryEntry(entry: SessionLibraryRecall.RetrievedMemory): string {
  return `<entry title="${entry.title}" similarity="${entry.similarity.toFixed(3)}">\n${entry.content}\n</entry>`
}

function renderMemoryBlock(groupedEntries: Map<SessionLibraryRecall.MemoryCategory, string[]>): string | undefined {
  const sections = [...groupedEntries.entries()]
    .filter(([, entries]) => entries.length > 0)
    .map(([category, entries]) => formatCategorySection(category, entries))
  if (sections.length === 0) return undefined
  return ["<active-memory>", ...sections, "</active-memory>"].join("\n")
}

function groupAlwaysRows(): Map<SessionLibraryRecall.MemoryCategory, string[]> {
  const grouped = new Map<SessionLibraryRecall.MemoryCategory, string[]>()
  for (const row of SessionLibraryRecall.listAlwaysMemories()) {
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
// Always-only memory context — reliable non-embedding injection
// ---------------------------------------------------------------------------

export function buildAlwaysOnlyMemoryResult(): { context: string; injection: InjectionInfo } | undefined {
  const grouped = groupAlwaysRows()
  const block = renderMemoryBlock(grouped)
  if (!block) return undefined
  return {
    context: [block, MEMORY_USAGE_HINT].join("\n\n"),
    injection: { memory: block },
  }
}

export function buildAlwaysOnlyMemoryContext(): string | undefined {
  return buildAlwaysOnlyMemoryResult()?.context
}

async function buildActiveMemoryContext(
  userText: string | undefined,
  activeRetrieval: ActiveRetrieval,
  queryVector?: number[],
): Promise<{ context: string; memoryBlock?: string }> {
  const parts: string[] = []
  const categories = Object.keys(activeRetrieval.categories) as SessionLibraryRecall.MemoryCategory[]
  const groupedEntries = groupAlwaysRows()

  const appendEntry = (category: SessionLibraryRecall.MemoryCategory, entry: string) => {
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
          const results = await SessionLibraryRecall.searchMemories({
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
      log.error("active memory semantic retrieval failed", { error: err })
    }
  }

  log.info("active memory context built", {
    entryCount: [...groupedEntries.values()].reduce((sum, arr) => sum + arr.length, 0),
  })

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
    const results = await SessionLibraryRecall.retrieveExperiences(scopeID, userText, {
      vector: queryVector,
      requireScript: true,
    })
    if (results.length === 0) return { context: undefined }

    SessionLibraryRecall.trackExperienceRetrieval(
      sessionID,
      results.map((r) => r.id),
    )

    const entries = results.map((r) => {
      const parts = [`<experience sim="${r.similarity.toFixed(3)}" q="${r.qValue.toFixed(3)}">`]
      parts.push(`<intent>${r.intent}</intent>`)
      parts.push(`<script>${r.script}</script>`)
      const evaluation = SessionLibraryRecall.buildExperienceEvaluation(r.rewards, learning.snapThreshold)
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

    SessionLibraryRecall.writeExperienceDebugLog(sessionID, scopeID, userText, results, injected)

    log.info("experience context built", { sessionID })
    return { context: injected }
  } catch (err: any) {
    log.error("memory retrieval failed", { error: err })
    return { context: undefined }
  }
}
function resolveActiveRetrieval(retrieval?: {
  simThreshold?: number
  topK?: number
  categories?: Record<string, { simThreshold?: number; topK?: number }>
}): ActiveRetrieval {
  const simThreshold = retrieval?.simThreshold ?? 0.7
  const topK = retrieval?.topK ?? 3
  const overrides = retrieval?.categories
  const categories = {} as Record<SessionLibraryRecall.MemoryCategory, CategoryRetrieval>
  for (const category of SessionLibraryRecall.MEMORY_CATEGORIES) {
    const override = overrides?.[category]
    categories[category] = {
      simThreshold: override?.simThreshold ?? simThreshold,
      topK: override?.topK ?? topK,
    }
  }
  return { enabled: true, categories }
}

interface ActiveRetrieval {
  enabled: boolean
  categories: Record<SessionLibraryRecall.MemoryCategory, CategoryRetrieval>
}

interface CategoryRetrieval {
  simThreshold: number
  topK: number
}

function resolveLearning(learning?: Config.Learning): Required<Config.Learning> {
  return {
    ...Config.LEARNING_DEFAULTS,
    ...learning,
    rewardWeights: { ...Config.REWARD_WEIGHT_DEFAULTS, ...learning?.rewardWeights },
  }
}
