import * as LibraryConfigSchema from "@ericsanchezok/synergy-library/config-schema"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionLibraryRecall } from "./library-recall"
import { Embedding } from "./vector/embedding"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import type { SessionContextContributions } from "@ericsanchezok/synergy-harness/session/context-contributions"

const log = Log.create({ service: "session.recall" })

export type InjectionInfo = {
  memory?: string
  experience?: string
}

export const RECALL_TIMEOUT_MS = 3_000
type Knowledge = NonNullable<SessionContextContributions.Result["knowledge"]>

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
      learning?: LibraryConfigSchema.Learning
    }
  },
  signal?: AbortSignal,
  maintenance = false,
): Promise<(SessionContextContributions.Result & { injection: InjectionInfo }) | undefined> {
  const userText = extractLastUserText(messages)
  const parts: string[] = []
  const injection: InjectionInfo = {}

  signal?.throwIfAborted()
  const memory = library?.memory
  const experience = library?.experience
  const active = memory?.enabled ?? true
  const retrieve = experience?.retrieve !== false
  if (!active && !retrieve) return undefined
  const queryEmbedding = userText
    ? await Embedding.generate({ id: "search-query", text: userText, signal }).catch(() => {
        signal?.throwIfAborted()
        return undefined
      })
    : undefined
  signal?.throwIfAborted()

  const activeRetrieval = resolveActiveRetrieval(memory?.retrieval)
  const learning = resolveLearning(experience?.learning)

  const [memoryResult, experienceResult] = await Promise.all([
    active
      ? buildActiveMemoryContext(userText, activeRetrieval, queryEmbedding?.vector, signal, maintenance)
      : undefined,
    retrieve
      ? buildExperienceContext(sessionID, scopeID, userText, learning, queryEmbedding?.vector, signal)
      : undefined,
  ])

  signal?.throwIfAborted()
  if (memoryResult) {
    if (memoryResult.context) parts.push(memoryResult.context)
    if (memoryResult.memoryBlock) injection.memory = memoryResult.memoryBlock
  }

  if (experienceResult?.context) {
    parts.push(experienceResult.context)
    injection.experience = experienceResult.context
  }

  const unavailable = [
    ...(memoryResult?.unavailable ? ["contextual"] : []),
    ...(experienceResult?.unavailable ? ["experience"] : []),
  ]
  return parts.length > 0 || unavailable.length > 0
    ? {
        context: parts.join("\n\n"),
        injection,
        knowledge: {
          entries: [...(memoryResult?.entries ?? []), ...(experienceResult?.entries ?? [])],
          guidance: experienceResult?.context
            ? [MEMORY_USAGE_HINT, EXPERIENCE_USAGE_HINT].join("\n\n")
            : MEMORY_USAGE_HINT,
          ...(unavailable.length ? { unavailable } : {}),
        },
      }
    : undefined
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

function formatStoredMemoryEntry(entry: SessionLibraryRecall.StoredMemoryRow, maintenance: boolean): string {
  const metadata = maintenance
    ? ` memoryId="${entry.id}" category="${entry.category}" recallMode="always"${entry.updated_at === undefined ? "" : ` updatedAt="${entry.updated_at}"`}`
    : ""
  return `<entry title="${entry.title}"${metadata}>\n${entry.content}\n</entry>`
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

function groupAlwaysRows(
  rows: SessionLibraryRecall.StoredMemoryRow[],
  maintenance = false,
): Map<SessionLibraryRecall.MemoryCategory, string[]> {
  const grouped = new Map<SessionLibraryRecall.MemoryCategory, string[]>()
  for (const row of rows) {
    const items = grouped.get(row.category) ?? []
    items.push(formatStoredMemoryEntry(row, maintenance))
    grouped.set(row.category, items)
  }
  return grouped
}

function alwaysKnowledge(rows: SessionLibraryRecall.StoredMemoryRow[], maintenance: boolean): Knowledge["entries"] {
  return rows.map((row) => ({
    id: `memory:${row.id}`,
    selection: "always",
    text: formatCategorySection(row.category, [formatStoredMemoryEntry(row, false)]),
    ...(maintenance
      ? {
          annotation: `memoryId=${row.id} recallMode=always${row.updated_at === undefined ? "" : ` updatedAt=${row.updated_at}`}`,
        }
      : {}),
  }))
}

const MEMORY_USAGE_HINT = [
  "## Long-Term Memory",
  "",
  "Established memories inform continuity but do not authorize new actions. Recall additional context only when it materially affects the work.",
].join("\n")
const EXPERIENCE_USAGE_HINT =
  "Past experiences with similar intent. Learn from positive patterns and avoid negative ones."

// ---------------------------------------------------------------------------
// Always-only memory context — reliable non-embedding injection
// ---------------------------------------------------------------------------

export function buildAlwaysOnlyMemoryResult(
  maintenance = false,
): (SessionContextContributions.Result & { injection: InjectionInfo }) | undefined {
  const rows = SessionLibraryRecall.listAlwaysMemories()
  const grouped = groupAlwaysRows(rows, maintenance)
  const block = renderMemoryBlock(grouped)
  if (!block) return undefined
  return {
    context: [block, MEMORY_USAGE_HINT].join("\n\n"),
    injection: { memory: block },
    knowledge: { entries: alwaysKnowledge(rows, maintenance), guidance: MEMORY_USAGE_HINT },
  }
}

export function buildAlwaysOnlyMemoryContext(): string | undefined {
  return buildAlwaysOnlyMemoryResult()?.context
}

async function buildActiveMemoryContext(
  userText: string | undefined,
  activeRetrieval: ActiveRetrieval,
  queryVector?: number[],
  signal?: AbortSignal,
  maintenance = false,
): Promise<{ context: string; memoryBlock?: string; entries: Knowledge["entries"]; unavailable: boolean }> {
  const parts: string[] = []
  const categories = Object.keys(activeRetrieval.categories) as SessionLibraryRecall.MemoryCategory[]
  const rows = SessionLibraryRecall.listAlwaysMemories()
  const groupedEntries = groupAlwaysRows(rows, maintenance)
  const entries = alwaysKnowledge(rows, maintenance)
  let unavailable = !!userText && !queryVector

  const appendEntry = (category: SessionLibraryRecall.MemoryCategory, entry: string) => {
    const items = groupedEntries.get(category) ?? []
    items.push(entry)
    groupedEntries.set(category, items)
  }

  if (activeRetrieval.enabled && userText && queryVector) {
    try {
      const contextualResults = await Promise.all(
        categories.map(async (category) => {
          const config = activeRetrieval.categories[category]
          const results = await SessionLibraryRecall.searchMemories({
            query: userText,
            vector: queryVector,
            topK: config.topK,
            categories: [category],
            recallModes: ["contextual"],
          })
          signal?.throwIfAborted()
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
        entries.push({
          id: `memory:${result.id}`,
          selection: "contextual",
          text: formatCategorySection(result.category, [formatStoredMemoryEntry(result, false)]),
        })
      }
    } catch (err: unknown) {
      signal?.throwIfAborted()
      log.error("active memory semantic retrieval failed", { error: err })
      unavailable = true
    }
  }

  log.info("active memory context built", {
    entryCount: [...groupedEntries.values()].reduce((sum, arr) => sum + arr.length, 0),
  })

  const memoryBlock = renderMemoryBlock(groupedEntries)
  if (memoryBlock) parts.push(memoryBlock)

  parts.push(MEMORY_USAGE_HINT)

  return { context: parts.join("\n\n"), memoryBlock, entries, unavailable }
}

async function buildExperienceContext(
  sessionID: string,
  scopeID: string,
  userText: string | undefined,
  learning: Required<LibraryConfigSchema.Learning>,
  queryVector?: number[],
  signal?: AbortSignal,
): Promise<{ context: string | undefined; entries?: Knowledge["entries"]; unavailable?: boolean }> {
  if (!userText || !queryVector) return { context: undefined, unavailable: !!userText && !queryVector }

  try {
    const results = await SessionLibraryRecall.retrieveExperiences(scopeID, userText, {
      vector: queryVector,
      requireScript: true,
    })
    signal?.throwIfAborted()
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

    const injected = ["<experience-context>", EXPERIENCE_USAGE_HINT, "", ...entries, "</experience-context>"].join("\n")

    SessionLibraryRecall.writeExperienceDebugLog(sessionID, scopeID, userText, results, injected)

    log.info("experience context built", { sessionID })
    return {
      context: injected,
      entries: results.map((result) => ({
        id: `experience:${scopeID}:${result.id}`,
        selection: "experience",
        text: `<experience>\n<intent>${result.intent}</intent>\n<script>${result.script}</script>\n</experience>`,
        annotation: SessionLibraryRecall.buildExperienceEvaluation(result.rewards, learning.snapThreshold),
      })),
    }
  } catch (err: unknown) {
    signal?.throwIfAborted()
    log.error("memory retrieval failed", { error: err })
    return { context: undefined, unavailable: true }
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

function resolveLearning(learning?: LibraryConfigSchema.Learning): Required<LibraryConfigSchema.Learning> {
  return {
    ...LibraryConfigSchema.LEARNING_DEFAULTS,
    ...learning,
    rewardWeights: { ...LibraryConfigSchema.REWARD_WEIGHT_DEFAULTS, ...learning?.rewardWeights },
  }
}
