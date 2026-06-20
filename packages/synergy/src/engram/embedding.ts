import z from "zod"
import { embed } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { pipeline } from "@huggingface/transformers"
import { Log } from "../util/log"
import { Config } from "../config/config"

export namespace Embedding {
  const log = Log.create({ service: "engram.embedding" })

  const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
  const DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B"
  const TIMEOUT_MS = 10_000

  // Local model singleton — created on first use
  let localExtractor: any
  let localModelReady = false
  let localModelError: Error | undefined

  async function getLocalExtractor() {
    if (localExtractor) return localExtractor
    if (localModelError) throw localModelError
    try {
      localExtractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" })
      localModelReady = true
      return localExtractor
    } catch (err) {
      localModelError = err instanceof Error ? err : new Error(String(err))
      throw localModelError
    }
  }

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

    let vector: number[]
    if (resolved.mode === "local") {
      const result = await resolved.extractor(input.text, { pooling: "mean", normalize: true })
      vector = Array.from(result.data as Float32Array)
    } else {
      const { embedding } = await embed({
        model: resolved.model,
        value: input.text,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      })
      vector = embedding as number[]
    }

    return {
      id: input.id,
      vector,
      model: resolved.modelID,
    }
  }

  export async function generateBatch(inputs: Input[]): Promise<Info[]> {
    if (inputs.length === 0) return []
    return Promise.all(inputs.map(generate))
  }

  /**
   * Start async warmup of the local embedding model.
   * Call this on server startup. Does not block — failures are silent.
   * While warmup is in progress, embedding calls that need the local model
   * will block until ready, so callers should use .catch() fallbacks.
   */
  export function warmup() {
    if (localModelReady || localModelError) return
    getLocalExtractor()
      .then(() => {
        log.info("local embedding model ready")
      })
      .catch((err) => {
        log.warn("local embedding model warmup failed", { error: err instanceof Error ? err.message : String(err) })
      })
  }

  /**
   * Release the local embedding model to free memory.
   * No-op if the model was never loaded or was already disposed.
   * Subsequent generate() calls will load the model again on demand.
   */
  export function dispose() {
    localExtractor = undefined
    localModelReady = false
    localModelError = undefined
  }

  async function resolveModel() {
    const config = await Config.get()
    const ec = config.embedding

    // User explicitly configured remote → use remote
    if (ec?.apiKey) {
      const baseURL = ec.baseURL ?? DEFAULT_BASE_URL
      const modelName = ec.model ?? DEFAULT_MODEL
      const provider = createOpenAICompatible({
        name: "embedding",
        baseURL,
        apiKey: ec.apiKey,
      })
      return {
        mode: "remote" as const,
        model: provider.textEmbeddingModel(modelName),
        modelID: modelName,
      }
    }

    // Zero-config → local
    try {
      const extractor = await getLocalExtractor()
      return { mode: "local" as const, extractor, modelID: "Xenova/all-MiniLM-L6-v2", dimensions: 384 }
    } catch (err) {
      throw new Error(
        `Embedding unavailable: no API key configured and local model failed to load. ` +
          `Configure embedding config or check network. ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
