import { Log } from "../util/log"
import { Embedding } from "./embedding"
import { Rerank } from "./rerank"
import { EngramDB } from "./database"

const log = Log.create({ service: "engram.memory-recall" })

const RERANK_CANDIDATE_MULTIPLIER = 3

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
    const topK = input.topK ?? 5
    const vector = input.vector ?? (await Embedding.generate({ id: "search-query", text: input.query })).vector
    const shouldRerank = input.rerank !== false

    const candidateCount = shouldRerank ? topK * RERANK_CANDIDATE_MULTIPLIER : topK
    const candidates = vectorSearch(vector, candidateCount, input.categories, input.recallModes)
    if (!shouldRerank || candidates.length <= topK) return candidates.slice(0, topK)

    return rerankResults(input.query, candidates, topK)
  }

  export function findSimilar(
    queryVector: number[],
    threshold: number,
  ): Array<{ id: string; title: string; category: EngramDB.Memory.Category; similarity: number; createdAt: number }> {
    const knnResults = EngramDB.Memory.searchByVector(queryVector, 20)
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
      const row = EngramDB.Memory.get(knn.id)
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

    const results: Result[] = []
    for (const knn of knnResults) {
      const row = EngramDB.Memory.get(knn.id)
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
      log.error("rerank failed, falling back to embedding order", { error: err?.message ?? String(err) })
      return candidates.slice(0, topK)
    }
  }
}
