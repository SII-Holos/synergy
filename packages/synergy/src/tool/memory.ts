import z from "zod"
import { Tool } from "./tool"
import { EngramDB } from "../engram/database"
import { Embedding } from "../engram/embedding"
import { MemoryRecall } from "../engram/memory-recall"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Config } from "../config/config"
import DESCRIPTION_WRITE from "./memory-write.txt"
import DESCRIPTION_EDIT from "./memory-edit.txt"
import DESCRIPTION_SEARCH from "./memory-search.txt"
import DESCRIPTION_GET from "./memory-get.txt"

const log = Log.create({ service: "tool.memory" })

const categorySchema = z.enum(EngramDB.Memory.CATEGORIES)
const recallModeSchema = z.enum(EngramDB.Memory.RECALL_MODES)

const writeParams = z.object({
  title: z.string().describe("A concise title summarizing the memory (10 words max)"),
  content: z.string().describe("The memory content to persist"),
  category: categorySchema.describe(
    "Memory category: user, self, relationship, interaction, workflow, coding, writing, asset, insight, knowledge, personal, or general",
  ),
  recallMode: recallModeSchema.describe("Memory recall mode: always, contextual, or search_only"),
})

export const MemoryWriteTool = Tool.define("memory_write", {
  description: DESCRIPTION_WRITE,
  parameters: writeParams,
  async execute(params: z.infer<typeof writeParams>) {
    const id = Identifier.ascending("memory")
    const embeddingText = `${params.title}\n${params.content}`

    let embedding: Embedding.Info
    try {
      embedding = await Embedding.generate({ id, text: embeddingText })
    } catch (err: any) {
      log.error("embedding failed", { error: err?.message ?? String(err) })
      return {
        title: "memory_write",
        output: `Failed to generate embedding: ${err?.message ?? String(err)}`,
        metadata: {} as Record<string, any>,
      }
    }

    const config = await Config.get()
    const evo = Config.resolveEvolution(config.identity?.evolution)
    const dedupThreshold = evo.memoryDedupThreshold

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

    EngramDB.Memory.insert(
      {
        id,
        title: params.title,
        content: params.content,
        category: params.category,
        recallMode: params.recallMode,
      },
      embedding,
    )

    return {
      title: "memory_write",
      output: `Memory stored successfully.\nID: ${id}\nCategory: ${params.category}\nRecall mode: ${params.recallMode}\nTitle: ${params.title}`,
      metadata: { id, title: params.title, category: params.category, recallMode: params.recallMode } as Record<
        string,
        any
      >,
    }
  },
})

const editParams = z.object({
  id: z.string().describe("The memory ID to edit"),
  title: z.string().describe("New title (10 words max)"),
  content: z.string().describe("New content to replace the existing memory"),
  category: categorySchema.describe(
    "Memory category: user, self, relationship, interaction, workflow, coding, writing, asset, insight, knowledge, personal, or general",
  ),
  recallMode: recallModeSchema.describe("Memory recall mode: always, contextual, or search_only"),
})

export const MemoryEditTool = Tool.define("memory_edit", {
  description: DESCRIPTION_EDIT,
  parameters: editParams,
  async execute(params: z.infer<typeof editParams>) {
    const existing = EngramDB.Memory.get(params.id)
    if (!existing) {
      return {
        title: "memory_edit",
        output: `Memory not found: ${params.id}`,
        metadata: {} as Record<string, any>,
      }
    }

    const embeddingText = `${params.title}\n${params.content}`
    let embedding: Embedding.Info
    try {
      embedding = await Embedding.generate({ id: params.id, text: embeddingText })
    } catch (err: any) {
      log.error("embedding failed", { error: err?.message ?? String(err) })
      return {
        title: "memory_edit",
        output: `Failed to generate embedding: ${err?.message ?? String(err)}`,
        metadata: {} as Record<string, any>,
      }
    }

    const updated = EngramDB.Memory.update(
      {
        id: params.id,
        title: params.title,
        content: params.content,
        category: params.category,
        recallMode: params.recallMode,
      },
      embedding,
    )
    if (!updated) {
      return {
        title: "memory_edit",
        output: `Failed to update memory: ${params.id}`,
        metadata: {} as Record<string, any>,
      }
    }

    return {
      title: "memory_edit",
      output: `Memory updated successfully.\nID: ${params.id}\nCategory: ${params.category}\nRecall mode: ${params.recallMode}\nTitle: ${params.title}`,
      metadata: {
        id: params.id,
        title: params.title,
        category: params.category,
        recallMode: params.recallMode,
      } as Record<string, any>,
    }
  },
})

const searchParams = z.object({
  query: z.string().describe("Search query"),
  top_k: z.coerce.number().describe("Number of results to return").default(5),
  categories: z.array(categorySchema).optional().describe("Optional category filters"),
  recallModes: z.array(recallModeSchema).optional().describe("Optional recall mode filters"),
})

export const MemorySearchTool = Tool.define("memory_search", {
  description: DESCRIPTION_SEARCH,
  parameters: searchParams,
  async execute(params: z.infer<typeof searchParams>) {
    let results: MemoryRecall.Result[]
    try {
      results = await MemoryRecall.search({
        query: params.query,
        topK: params.top_k,
        categories: params.categories,
        recallModes: params.recallModes,
      })
    } catch (err: any) {
      log.error("search failed", { error: err?.message ?? String(err) })
      return {
        title: "memory_search",
        output: `Failed to search memories: ${err?.message ?? String(err)}`,
        metadata: {} as Record<string, any>,
      }
    }

    if (results.length === 0) {
      return {
        title: "memory_search",
        output: "No memories found.",
        metadata: { count: 0 } as Record<string, any>,
      }
    }

    const lines = results.map((r) => {
      const date = new Date(r.createdAt).toISOString()
      return `- [${r.id}] "${r.title}" [${r.category}/${r.recallMode}] (similarity: ${(r.similarity * 100).toFixed(1)}%, created: ${date})`
    })

    return {
      title: "memory_search",
      output: `Found ${results.length} memor${results.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`,
      metadata: { count: results.length } as Record<string, any>,
    }
  },
})

const getParams = z.object({
  ids: z.array(z.string()).describe("List of memory IDs to retrieve"),
})

export const MemoryGetTool = Tool.define("memory_get", {
  description: DESCRIPTION_GET,
  parameters: getParams,
  async execute(params: z.infer<typeof getParams>) {
    const rows = EngramDB.Memory.getMany(params.ids)
    if (rows.length === 0) {
      return {
        title: "memory_get",
        output: `No memories found for the given IDs.`,
        metadata: { count: 0 } as Record<string, any>,
      }
    }

    const entries = rows.map((r) => {
      const date = new Date(r.created_at).toISOString()
      return [`[${r.id}] ${r.title} [${r.category}/${r.recall_mode}] (created: ${date})`, r.content].join("\n")
    })

    return {
      title: "memory_get",
      output: entries.join("\n\n---\n\n"),
      metadata: { count: rows.length } as Record<string, any>,
    }
  },
})
