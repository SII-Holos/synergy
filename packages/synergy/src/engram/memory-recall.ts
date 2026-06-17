import { Log } from "../util/log"
import { Plugin } from "../plugin"
import { Embedding } from "./embedding"
import { Rerank } from "./rerank"
import { EngramDB } from "./database"
import { Config } from "../config/config"

const log = Log.create({ service: "engram.memory-recall" })

const RERANK_CANDIDATE_MULTIPLIER = 3

// Simple BM25-like text match fallback when embeddings are unavailable
function textSearch(query: string, candidates: Array<{ id: string; text: string }>, topK: number) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1)
  if (terms.length === 0) return candidates.slice(0, topK)
  return candidates
    .map((c) => {
      const text = c.text.toLowerCase()
      let score = 0
      for (const term of terms) {
        let pos = 0
        while ((pos = text.indexOf(term, pos)) !== -1) {
          score += 1
          pos++
        }
      }
      return { ...c, score }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

export namespace MemoryRecall {
  export interface Result {
    id: string
    title: string
    content: string
    category: EngramDB.Memory.Category
    recallMode: EngramDB.Memory.RecallMode
    similarity: number
    createdAt: number
    updatedAt: number
  }

  export interface SearchInput {
    query: string
    vector?: number[]
    topK?: number
    categories?: EngramDB.Memory.Category[]
    recallModes?: EngramDB.Memory.RecallMode[]
    rerank?: boolean
  }

  export async function search(input: SearchInput): Promise<Result[]> {
    const search = await Plugin.trigger(
      "engram.memory.search.before",
      {},
      {
        query: input.query,
        vector: input.vector,
        topK: input.topK,
        categories: input.categories,
        recallModes: input.recallModes,
        rerank: input.rerank,
      },
    )

    const topK = search.topK ?? 5
    const shouldRerank = search.rerank === true

    let vector: number[]
    try {
      vector = search.vector ?? (await Embedding.generate({ id: "search-query", text: search.query })).vector
    } catch {
      // Embedding unavailable — fall back to text search
      const memoryCandidates = EngramDB.Memory.listAll().map((r) => ({
        id: r.id,
        text: `${r.title}\n${r.content}`,
      }))
      return (textSearch(search.query, memoryCandidates, topK) as any[]).map((c) => ({
        id: c.id,
        title: "",
        content: c.text,
        category: "general" as EngramDB.Memory.Category,
        recallMode: "contextual" as EngramDB.Memory.RecallMode,
        similarity: c.score / (search.query.split(/\s+/).filter((t: string) => t.length > 1).length || 1),
        createdAt: 0,
        updatedAt: 0,
      }))
    }

    const candidateCount = shouldRerank ? topK * RERANK_CANDIDATE_MULTIPLIER : topK
    const candidates = vectorSearch(vector, candidateCount, search.categories, search.recallModes)
    const results =
      !shouldRerank || candidates.length <= topK
        ? candidates.slice(0, topK)
        : await rerankResults(search.query, candidates, topK)

    const output = await Plugin.trigger(
      "engram.memory.search.after",
      {
        query: search.query,
        topK,
      },
      {
        results,
      },
    )

    return output.results
  }

  export function findSimilar(
    queryVector: number[],
    threshold: number,
  ): Array<{ id: string; title: string; category: EngramDB.Memory.Category; similarity: number; createdAt: number }> {
    const knnResults = EngramDB.Memory.searchByVector(queryVector, 20)
    if (knnResults.length === 0) return []

    const rows = new Map(EngramDB.Memory.getMany(knnResults.map((k) => k.id)).map((r) => [r.id, r]))
    const results: Array<{
      id: string
      title: string
      category: EngramDB.Memory.Category
      similarity: number
      createdAt: number
    }> = []

    for (const knn of knnResults) {
      const similarity = 1 - knn.distance
      if (similarity < threshold) continue
      const row = rows.get(knn.id)
      if (!row) continue
      results.push({
        id: row.id,
        title: row.title,
        category: row.category,
        similarity,
        createdAt: row.created_at,
      })
    }

    return results
  }

  function vectorSearch(
    queryVector: number[],
    topK: number,
    categories?: EngramDB.Memory.Category[],
    recallModes?: EngramDB.Memory.RecallMode[],
  ): Result[] {
    const category = categories?.length === 1 ? categories[0] : undefined
    const knnResults = EngramDB.Memory.searchByVector(queryVector, topK, category)
    if (knnResults.length === 0) return []

    const rows = new Map(EngramDB.Memory.getMany(knnResults.map((k) => k.id)).map((r) => [r.id, r]))

    const results: Result[] = []
    for (const knn of knnResults) {
      const row = rows.get(knn.id)
      if (!row) continue
      if (categories && categories.length > 1 && !categories.includes(row.category)) continue
      if (recallModes && !recallModes.includes(row.recall_mode)) continue
      results.push({
        id: row.id,
        title: row.title,
        content: row.content,
        category: row.category,
        recallMode: row.recall_mode,
        similarity: 1 - knn.distance,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }

    log.info("vectorSearch", {
      categories: categories?.join(",") ?? "all",
      recallModes: recallModes?.join(",") ?? "all",
      results: results.length,
    })
    return results
  }

  async function rerankResults(query: string, candidates: Result[], topK: number): Promise<Result[]> {
    try {
      const documents = candidates.map((c) => `${c.title}\n${c.content}`)
      const reranked = await Rerank.rerank({ query, documents, topN: topK })
      const results = reranked.map((r) => ({
        ...candidates[r.index],
        similarity: r.relevanceScore,
      }))
      log.info("reranked", { candidates: candidates.length, results: results.length })
      return results
    } catch (err: any) {
      log.error("rerank failed, falling back to embedding order", { error: err })
      return candidates.slice(0, topK)
    }
  }
}
