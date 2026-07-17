import z from "zod"
import { embed } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Log } from "../util/log"
import { Config } from "../config/config"

export interface LocalExtractor {
  (input: string, options: { pooling: "mean"; normalize: true }): Promise<{ data: Float32Array }>
  dispose(): Promise<void>
}

export class LocalEmbeddingRuntime {
  private extractor: LocalExtractor | undefined
  private loading: Promise<LocalExtractor> | undefined
  private generation = 0
  private loadError: Error | undefined

  constructor(
    private readonly load: () => Promise<LocalExtractor>,
    private readonly onDisposeError: (error: unknown) => void = () => {},
  ) {}

  get ready(): boolean {
    return this.extractor !== undefined
  }

  get error(): Error | undefined {
    return this.loadError
  }

  clearError(): void {
    this.loadError = undefined
  }

  async get(): Promise<LocalExtractor> {
    if (this.extractor) return this.extractor
    if (this.loading) return this.loading

    const generation = this.generation
    const loading = this.load()
      .then(async (extractor) => {
        if (generation !== this.generation) {
          await this.release(extractor)
          throw new Error("Local embedding runtime disposed during load")
        }
        this.extractor = extractor
        return extractor
      })
      .catch((error) => {
        if (generation === this.generation) {
          this.loadError = error instanceof Error ? error : new Error(String(error))
        }
        throw error
      })
      .finally(() => {
        if (this.loading === loading) this.loading = undefined
      })
    this.loading = loading
    return loading
  }

  async dispose(): Promise<void> {
    this.generation++
    const extractor = this.extractor
    const loading = this.loading
    this.extractor = undefined
    this.loadError = undefined
    if (extractor) await this.release(extractor)
    await loading?.catch(() => undefined)
  }

  private async release(extractor: LocalExtractor): Promise<void> {
    await extractor.dispose().catch(this.onDisposeError)
  }
}

export namespace Embedding {
  const log = Log.create({ service: "vector.embedding" })

  const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
  const DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B"
  const TIMEOUT_MS = 10_000

  const localRuntime = new LocalEmbeddingRuntime(loadLocalExtractor, (error) => {
    log.warn("failed to dispose local embedding model", { error })
  })

  async function loadLocalExtractor(): Promise<LocalExtractor> {
    const transformersPackage = "@huggingface/transformers"
    const { pipeline } = await import(transformersPackage)

    try {
      return (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "q8",
      })) as unknown as LocalExtractor
    } catch (networkErr) {
      log.warn("local embedding model: network load failed, trying from disk cache", {
        error: networkErr instanceof Error ? networkErr.message : String(networkErr),
      })
    }

    try {
      const extractor = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "q8",
        local_files_only: true,
      })) as unknown as LocalExtractor
      log.info("local embedding model loaded from disk cache (offline)")
      return extractor
    } catch (cacheErr) {
      throw cacheErr instanceof Error ? cacheErr : new Error(String(cacheErr))
    }
  }

  async function getLocalExtractor(): Promise<LocalExtractor> {
    if (localRuntime.error) {
      log.info("retrying local embedding model load (previous attempt failed)")
      localRuntime.clearError()
    }
    return localRuntime.get()
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
    signal?: AbortSignal
  }
  export async function generate(input: Input): Promise<Info> {
    using _ = log.time("generate", { id: input.id })
    input.signal?.throwIfAborted()
    const resolved = await resolveModel()
    input.signal?.throwIfAborted()

    let vector: number[]
    if (resolved.mode === "local") {
      const result = await resolved.extractor(input.text, { pooling: "mean", normalize: true })
      input.signal?.throwIfAborted()
      vector = Array.from(result.data as Float32Array)
    } else {
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const abortSignal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
      const { embedding } = await embed({
        model: resolved.model,
        value: input.text,
        abortSignal,
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
   * Start the local embedding model download. Returns a Promise that resolves
   * when the model is ready or rejects if loading fails.
   * Call this on server startup or from the CLI. While loading is in progress,
   * embedding calls that need the local model will block until ready.
   */
  export function warmup(): Promise<void> {
    if (localRuntime.ready) return Promise.resolve()
    if (localRuntime.error) return Promise.reject(localRuntime.error)
    return getLocalExtractor()
      .then(() => {
        log.info("local embedding model ready")
      })
      .catch((err) => {
        log.warn("local embedding model warmup failed", { error: err instanceof Error ? err.message : String(err) })
        throw err
      })
  }

  /**
   * Release the local embedding model to free memory.
   * No-op if the model was never loaded or was already disposed.
   * Subsequent generate() calls will load the model again on demand.
   */
  export async function dispose(): Promise<void> {
    await localRuntime.dispose()
  }

  async function resolveModel() {
    const config = await Config.current()
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
