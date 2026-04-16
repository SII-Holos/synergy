import z from "zod"
import { embed } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Log } from "../util/log"
import { Config } from "../config/config"

export namespace Embedding {
  const log = Log.create({ service: "engram.embedding" })

  const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
  const DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B"
  const TIMEOUT_MS = 10_000

  export const Info = z
    .object({
      id: z.string(),
      vector: z.number().array(),
      model: z.string(),
    })
    .meta({ ref: "EmbeddingInfo" })
  export type Info = z.infer<typeof Info>

  export interface Input {
    id: string
    text: string
  }

  export async function generate(input: Input): Promise<Info> {
    using _ = log.time("generate", { id: input.id })
    const resolved = await resolveModel()
    const { embedding } = await embed({
      model: resolved.model,
      value: input.text,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return {
      id: input.id,
      vector: embedding,
      model: resolved.modelID,
    }
  }

  export async function generateBatch(inputs: Input[]): Promise<Info[]> {
    if (inputs.length === 0) return []
    return Promise.all(inputs.map(generate))
  }

  async function resolveModel() {
    const config = await Config.get()
    const embeddingConfig = config.identity?.embedding

    const baseURL = embeddingConfig?.baseURL ?? DEFAULT_BASE_URL
    const apiKey = embeddingConfig?.apiKey
    const modelName = embeddingConfig?.model ?? DEFAULT_MODEL

    if (!apiKey) {
      throw new Error("Embedding API key is required. Configure it in identity.embedding.apiKey in your synergy.jsonc.")
    }

    const provider = createOpenAICompatible({
      name: "embedding",
      baseURL,
      apiKey,
    })

    return {
      model: provider.textEmbeddingModel(modelName),
      modelID: modelName,
    }
  }
}
