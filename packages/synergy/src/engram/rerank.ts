import z from "zod"
import { Log } from "../util/log"
import { Config } from "../config/config"

export namespace Rerank {
  const log = Log.create({ service: "engram.rerank" })

  const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
  const DEFAULT_MODEL = "Qwen/Qwen3-Reranker-8B"
  const TIMEOUT_MS = 10_000

  export const Result = z.object({
    index: z.number(),
    relevanceScore: z.number(),
    document: z.string().optional(),
  })
  export type Result = z.infer<typeof Result>

  export interface Input {
    query: string
    documents: string[]
    topN?: number
  }

  export async function rerank(input: Input): Promise<Result[]> {
    if (input.documents.length === 0) return []
    using _ = log.time("rerank", { documents: input.documents.length, topN: input.topN })
    const resolved = await resolveConfig()

    const response = await fetch(`${resolved.baseURL}/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        query: input.query,
        documents: input.documents,
        top_n: input.topN ?? input.documents.length,
        return_documents: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`Rerank API error ${response.status}: ${body}`)
    }

    const data = (await response.json()) as {
      results: Array<{ index: number; relevance_score: number; document?: { text: string } }>
    }

    return data.results.map((r) => ({
      index: r.index,
      relevanceScore: r.relevance_score,
      document: r.document?.text,
    }))
  }

  async function resolveConfig() {
    const config = await Config.get()
    const rerankConfig = config.identity?.rerank
    const embeddingConfig = config.identity?.embedding

    const baseURL = rerankConfig?.baseURL ?? DEFAULT_BASE_URL
    const apiKey = rerankConfig?.apiKey ?? embeddingConfig?.apiKey
    const model = rerankConfig?.model ?? DEFAULT_MODEL

    if (!apiKey) {
      throw new Error(
        "Rerank API key is required. Configure it in identity.rerank.apiKey or identity.embedding.apiKey in your synergy.jsonc.",
      )
    }

    return { baseURL, apiKey, model }
  }
}
