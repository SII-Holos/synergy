import { formatLocalDateTime } from "@ericsanchezok/synergy-harness/util/time-format"
import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { LibraryDB } from "../database"
import { Embedding } from "../vector/embedding"
import { MemoryRecall } from "../memory-recall"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import DESCRIPTION_WRITE from "./memory-write.txt"
import DESCRIPTION_EDIT from "./memory-edit.txt"
import DESCRIPTION_SEARCH from "./memory-search.txt"
import DESCRIPTION_GET from "./memory-get.txt"

const log = Log.create({ service: "tool.memory" })

const categorySchema = z.enum(LibraryDB.Memory.CATEGORIES)
const recallModeSchema = z.enum(LibraryDB.Memory.RECALL_MODES)

const writeParams = z.object({
  memoryTitle: z.string().describe("A concise title summarizing the memory (10 words max)"),
  memoryContent: z.string().describe("The memory content to persist"),
  category: categorySchema.describe(
    "Memory category: user, self, relationship, interaction, workflow, coding, writing, asset, insight, knowledge, personal, or general",
  ),
  recallMode: recallModeSchema.describe("Memory recall mode: always, contextual, or search_only"),
})

export const MemoryWriteTool = Tool.define(
  "memory_write",
  {
    description: DESCRIPTION_WRITE,
    parameters: writeParams,
    async execute(params: z.infer<typeof writeParams>) {
      const id = Identifier.ascending("memory")
      const embeddingText = `${params.memoryTitle}\n${params.memoryContent}`

      let embedding: Embedding.Info
      try {
        embedding = await Embedding.generate({ id, text: embeddingText })
      } catch (error) {
        log.error("embedding failed", { error })
        throw new Error(
          `Failed to generate embedding: ${error instanceof Error ? error.message : String(error)}. Retry when the embedding service is available.`,
          { cause: error },
        )
      }

      const config = await Config.current()
      const dedupThreshold = (config as any).library?.memory?.dedup?.threshold ?? 0.75

      const similar = MemoryRecall.findSimilar(embedding.vector, dedupThreshold)

      if (similar.length > 0) {
        const similarList = similar
          .map((s) => `- [${s.id}] "${s.title}" [${s.category}] (similarity: ${(s.similarity * 100).toFixed(1)}%)`)
          .join("\n")

        return {
          title: "memory_write",
          output: [
            `Found ${similar.length} similar existing memor${similar.length === 1 ? "y" : "ies"}:`,
            similarList,
            "",
            "The memory you are trying to write is semantically similar to the above. Consider using `memory_edit` to update an existing memory instead of creating a duplicate.",
            "If you still want to create a new memory, call `memory_write` again with a more distinct content.",
          ].join("\n"),
          metadata: { similarCount: similar.length, action: "similar_found" } as Record<string, any>,
        }
      }

      LibraryDB.Memory.insert(
        {
          id,
          title: params.memoryTitle,
          content: params.memoryContent,
          category: params.category,
          recallMode: params.recallMode,
        },
        embedding,
      )

      return {
        title: "memory_write",
        output: JSON.stringify(
          {
            memoryId: id,
            memoryTitle: params.memoryTitle,
            memoryContent: params.memoryContent,
            category: params.category,
            recallMode: params.recallMode,
          },
          null,
          2,
        ),
        metadata: { id, title: params.memoryTitle, category: params.category, recallMode: params.recallMode } as Record<
          string,
          any
        >,
      }
    },
  },
  { activityKind: "object" },
)

const editParams = z.object({
  memoryId: z.string().describe("The memory ID to edit"),
  memoryTitle: z.string().describe("New title (10 words max)"),
  memoryContent: z.string().describe("New content to replace the existing memory"),
  category: categorySchema.describe(
    "Memory category: user, self, relationship, interaction, workflow, coding, writing, asset, insight, knowledge, personal, or general",
  ),
  recallMode: recallModeSchema.describe("Memory recall mode: always, contextual, or search_only"),
})

export const MemoryEditTool = Tool.define(
  "memory_edit",
  {
    description: DESCRIPTION_EDIT,
    parameters: editParams,
    async execute(params: z.infer<typeof editParams>) {
      const existing = LibraryDB.Memory.get(params.memoryId)
      if (!existing) {
        return {
          title: "memory_edit",
          output: `Memory not found: ${params.memoryId}`,
          metadata: {} as Record<string, any>,
        }
      }

      const embeddingText = `${params.memoryTitle}\n${params.memoryContent}`
      let embedding: Embedding.Info
      try {
        embedding = await Embedding.generate({ id: params.memoryId, text: embeddingText })
      } catch (error) {
        log.error("embedding failed", { error })
        throw new Error(
          `Failed to generate embedding: ${error instanceof Error ? error.message : String(error)}. Retry when the embedding service is available.`,
          { cause: error },
        )
      }

      const updated = LibraryDB.Memory.update(
        {
          id: params.memoryId,
          title: params.memoryTitle,
          content: params.memoryContent,
          category: params.category,
          recallMode: params.recallMode,
        },
        embedding,
      )
      if (!updated) {
        return {
          title: "memory_edit",
          output: `Failed to update memory: ${params.memoryId}`,
          metadata: {} as Record<string, any>,
        }
      }

      return {
        title: "memory_edit",
        output: JSON.stringify(
          {
            memoryId: params.memoryId,
            memoryTitle: params.memoryTitle,
            memoryContent: params.memoryContent,
            category: params.category,
            recallMode: params.recallMode,
          },
          null,
          2,
        ),
        metadata: {
          id: params.memoryId,
          title: params.memoryTitle,
          category: params.category,
          recallMode: params.recallMode,
        } as Record<string, any>,
      }
    },
  },
  { activityKind: "object" },
)

const searchParams = z.object({
  query: z.string().describe("Search query"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("Maximum memories to return, from 1 to 100; defaults to 5")
    .default(5),
  categories: z.array(categorySchema).optional().describe("Optional category filters"),
  recallModes: z.array(recallModeSchema).optional().describe("Optional recall mode filters"),
})

export const MemorySearchTool = Tool.define(
  "memory_search",
  {
    description: DESCRIPTION_SEARCH,
    parameters: searchParams,
    async execute(params: z.infer<typeof searchParams>) {
      let results: MemoryRecall.Result[]
      try {
        results = await MemoryRecall.search({
          query: params.query,
          topK: params.limit,
          categories: params.categories,
          recallModes: params.recallModes,
        })
      } catch (err: any) {
        log.error("search failed", { error: err })
        return {
          title: "memory_search",
          output: `Failed to search memories: ${err?.message ?? String(err)}`,
          metadata: {} as Record<string, any>,
        }
      }

      if (results.length === 0) {
        const vecReady = LibraryDB.isMemoryVecReady()
        const output = vecReady
          ? "No memories found."
          : "No memories found. (Vector search is currently unavailable — memory recall may be degraded.)"
        return {
          title: "memory_search",
          output,
          metadata: { count: 0, degraded: !vecReady } as Record<string, any>,
        }
      }

      return {
        title: "memory_search",
        output: JSON.stringify(
          results.map((r) => ({
            memoryId: r.id,
            memoryTitle: r.title,
            category: r.category,
            recallMode: r.recallMode,
            similarity: r.similarity,
            createdAt: formatLocalDateTime(r.createdAt),
          })),
          null,
          2,
        ),
        metadata: { count: results.length } as Record<string, any>,
      }
    },
  },
  { activityKind: "object" },
)

const getParams = z.object({
  memoryIds: z.array(z.string()).describe("List of memory IDs to retrieve"),
})

export const MemoryGetTool = Tool.define(
  "memory_get",
  {
    description: DESCRIPTION_GET,
    parameters: getParams,
    async execute(params: z.infer<typeof getParams>) {
      const rows = LibraryDB.Memory.getMany(params.memoryIds)
      if (rows.length === 0) {
        return {
          title: "memory_get",
          output: `No memories found for the given IDs.`,
          metadata: { count: 0 } as Record<string, any>,
        }
      }

      return {
        title: "memory_get",
        output: JSON.stringify(
          rows.map((r) => ({
            memoryId: r.id,
            memoryTitle: r.title,
            memoryContent: r.content,
            category: r.category,
            recallMode: r.recall_mode,
            createdAt: formatLocalDateTime(r.created_at),
          })),
          null,
          2,
        ),
        metadata: { count: rows.length } as Record<string, any>,
      }
    },
  },
  { activityKind: "object" },
)
