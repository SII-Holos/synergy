import { ProviderPricing } from "@/provider/pricing"
import z from "zod"
import { Log } from "../util/log"
import { Config } from "../config/config"
import { RolloutOperation } from "@/session/rollout/operation"
import { RolloutTransport } from "@/session/rollout/transport"
import { RolloutContext } from "@/session/rollout/context"

export namespace Rerank {
  const log = Log.create({ service: "vector.rerank" })

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

    const request = {
      model: resolved.model,
      query: input.query,
      documents: input.documents,
      top_n: input.topN ?? input.documents.length,
      return_documents: false,
    }
    return RolloutOperation.execute(
      {
        purpose: "rerank",
        kind: "rerank",
        model: {
          providerID: "rerank",
          modelID: resolved.model,
          sdk: "@ai-sdk/openai-compatible",
          pricing: resolved.pricing,
        },
        request,
      },
      async () => {
        const response = await RolloutTransport.fetch(fetch, `${resolved.baseURL}/rerank`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resolved.apiKey}`,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.any([
            AbortSignal.timeout(TIMEOUT_MS),
            ...(RolloutContext.current()?.signal ? [RolloutContext.current()!.signal!] : []),
          ]),
        })

        if (!response.ok) {
          const body = await response.text()
          throw new Error(`Rerank API error ${response.status}: ${body}`)
        }

        const data = (await response.json()) as {
          results: Array<{ index: number; relevance_score: number; document?: { text: string } }>
        }

        const value = data.results.map((r) => ({
          index: r.index,
          relevanceScore: r.relevance_score,
          document: r.document?.text,
        }))
        return { value, response: JSON.parse(JSON.stringify(data)) }
      },
    )
  }

  async function resolveConfig() {
    const config = await Config.current()
    const rerankConfig = config.rerank
    const embeddingConfig = config.embedding

    const baseURL = rerankConfig?.baseURL ?? DEFAULT_BASE_URL
    const apiKey = rerankConfig?.apiKey ?? embeddingConfig?.apiKey
    const model = rerankConfig?.model ?? DEFAULT_MODEL

    if (!apiKey) {
      throw new Error(
        "Rerank API key is required. Configure it in rerank.apiKey or embedding.apiKey in 00-general.jsonc.",
      )
    }

    return {
      baseURL,
      apiKey,
      model,
      pricing: ProviderPricing.resolve({
        providerID: "rerank",
        modelID: model,
        cost: rerankConfig?.cost,
        source: "configuration",
      }),
    }
  }
}
