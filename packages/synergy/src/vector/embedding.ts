import z from "zod"
import { embed } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Log } from "../util/log"
import { Config } from "../config/config"
import { normalizePublicHttpsOrigin } from "../util/public-https-origin"

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
  const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2"
  const LOCAL_TASK = "feature-extraction"
  const LOCAL_DIMENSIONS = 384
  const HUGGINGFACE_HOST = "https://huggingface.co/"
  const HF_MIRROR_HOST = "https://hf-mirror.com/"
  const TIMEOUT_MS = 10_000

  type LocalSource = "huggingface" | "hf-mirror" | "custom"
  type ProgressInfo = {
    status?: string
    progress?: number
    loaded?: number
    total?: number
  }
  type PipelineOptions = {
    dtype: "q8"
    progress_callback: (info: ProgressInfo) => void
    local_files_only?: true
  }
  type LocalRuntime = {
    pipeline(task: string, model: string, options: PipelineOptions): Promise<LocalExtractor>
    isCached(task: string, model: string, options: { dtype: "q8" }): Promise<boolean>
    configure(input: { remoteHost: string }): void
  }
  type LocalRuntimeControls = {
    loadRuntime(): Promise<LocalRuntime>
  }
  type ProgressSnapshot = {
    loadedBytes: number
    totalBytes: number
    percent: number
  }
  type LocalError = {
    code: "invalid_source" | "load_failed"
    message: string
  }
  type LocalLoadState =
    | {
        phase: "unloaded"
        source?: LocalSource
        remoteHost?: string
        asset?: "missing" | "cached" | "failed"
        progress?: ProgressSnapshot
        error?: LocalError
      }
    | {
        phase: "loading"
        source?: LocalSource
        remoteHost?: string
        asset: "missing" | "downloading" | "cached"
        progress?: ProgressSnapshot
      }
    | {
        phase: "ready"
        source: LocalSource
        remoteHost: string
        progress: ProgressSnapshot
      }

  export type LocalStatus = {
    mode: "local"
    model: string
    source: LocalSource
    asset: "missing" | "downloading" | "cached" | "failed"
    runtime: "unloaded" | "loading" | "ready"
    progress?: ProgressSnapshot
    error?: LocalError
  }

  export type RemoteStatus = {
    mode: "remote"
    model: string
    baseURL: string
  }

  let loadState: LocalLoadState = { phase: "unloaded" }
  let runtimeControls: LocalRuntimeControls = defaultRuntimeControls()
  let loadGeneration = 0
  const localRuntime = new LocalEmbeddingRuntime(loadLocalExtractor, (error) => {
    log.warn("failed to dispose local embedding model", { error })
  })

  function defaultRuntimeControls(): LocalRuntimeControls {
    return {
      async loadRuntime() {
        const transformersPackage = "@huggingface/transformers"
        const runtime = await import(transformersPackage)
        return {
          pipeline: runtime.pipeline as unknown as LocalRuntime["pipeline"],
          isCached: (task, model, options) => runtime.ModelRegistry.is_pipeline_cached(task, model, options),
          configure({ remoteHost }) {
            runtime.env.remoteHost = remoteHost
          },
        }
      },
    }
  }

  function resolveLocalSource(config: Config.Info) {
    const source = config.embedding?.local?.source ?? "huggingface"
    if (source === "huggingface") return { source, remoteHost: HUGGINGFACE_HOST }
    if (source === "hf-mirror") return { source, remoteHost: HF_MIRROR_HOST }
    const remoteHost = config.embedding?.local?.remoteHost
    if (!remoteHost) throw new Error("Local embedding custom source must be a public HTTPS origin")
    return { source, remoteHost: normalizePublicHttpsOrigin(remoteHost) }
  }

  function completeProgress(progress?: ProgressSnapshot): ProgressSnapshot {
    const totalBytes = progress?.totalBytes ?? 0
    return {
      loadedBytes: totalBytes,
      totalBytes,
      percent: 100,
    }
  }

  function progressFrom(info: ProgressInfo): ProgressSnapshot | undefined {
    if (info.status !== "progress_total") return
    const loadedBytes = Number.isFinite(info.loaded) ? Math.max(0, info.loaded ?? 0) : 0
    const totalBytes = Number.isFinite(info.total) ? Math.max(0, info.total ?? 0) : 0
    const percent = Number.isFinite(info.progress)
      ? Math.min(100, Math.max(0, info.progress ?? 0))
      : totalBytes > 0
        ? Math.min(100, (loadedBytes / totalBytes) * 100)
        : 0
    return { loadedBytes, totalBytes, percent }
  }

  async function inspectLocalAsset(source: LocalSource, remoteHost: string) {
    const runtime = await runtimeControls.loadRuntime()
    runtime.configure({ remoteHost })
    const cached = await runtime.isCached(LOCAL_TASK, LOCAL_MODEL, { dtype: "q8" })
    return { runtime, cached }
  }

  async function loadLocalExtractor(): Promise<LocalExtractor> {
    const retrying = loadState.phase === "unloaded" && Boolean(loadState.error)
    const generation = ++loadGeneration
    const loading: Extract<LocalLoadState, { phase: "loading" }> = {
      phase: "loading",
      asset: "missing",
    }
    loadState = loading

    let source: LocalSource
    let remoteHost: string
    try {
      const config = await Config.current()
      ;({ source, remoteHost } = resolveLocalSource(config))
      loading.source = source
      loading.remoteHost = remoteHost
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (loadGeneration === generation) {
        loadState = {
          phase: "unloaded",
          asset: "failed",
          error: { code: "invalid_source", message: error.message },
        }
      }
      throw error
    }

    if (retrying) log.info("retrying local embedding model load (previous attempt failed)")

    try {
      const inspected = await inspectLocalAsset(source, remoteHost)
      loading.asset = inspected.cached ? "cached" : "downloading"
      const progressCallback = (info: ProgressInfo) => {
        const progress = progressFrom(info)
        if (!progress) return
        loading.asset = "downloading"
        loading.progress = progress
      }

      let extractor: LocalExtractor
      try {
        extractor = await inspected.runtime.pipeline(LOCAL_TASK, LOCAL_MODEL, {
          dtype: "q8",
          progress_callback: progressCallback,
        })
      } catch (networkError) {
        log.warn("local embedding model: network load failed, trying from disk cache", {
          error: networkError instanceof Error ? networkError.message : String(networkError),
        })
        loading.asset = "cached"
        extractor = await inspected.runtime.pipeline(LOCAL_TASK, LOCAL_MODEL, {
          dtype: "q8",
          local_files_only: true,
          progress_callback: progressCallback,
        })
        log.info("local embedding model loaded from disk cache (offline)")
      }

      if (loadGeneration === generation) {
        loadState = {
          phase: "ready",
          source,
          remoteHost,
          progress: completeProgress(loading.progress),
        }
      }
      return extractor
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (loadGeneration === generation) {
        loadState = {
          phase: "unloaded",
          source,
          remoteHost,
          asset: "failed",
          error: { code: "load_failed", message: error.message },
        }
      }
      throw error
    }
  }

  async function getLocalExtractor(): Promise<LocalExtractor> {
    if (localRuntime.error) {
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
      vector = Array.from(result.data)
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

  export async function status(): Promise<LocalStatus | RemoteStatus> {
    const config = await Config.current()
    const ec = config.embedding
    if (ec?.apiKey) {
      return {
        mode: "remote",
        model: ec.model ?? DEFAULT_MODEL,
        baseURL: ec.baseURL ?? DEFAULT_BASE_URL,
      }
    }

    if (loadState.phase === "ready") {
      return {
        mode: "local",
        model: LOCAL_MODEL,
        source: loadState.source,
        asset: "cached",
        runtime: "ready",
        progress: loadState.progress,
      }
    }
    if (loadState.phase === "loading") {
      let source = loadState.source
      if (!source) {
        try {
          source = resolveLocalSource(config).source
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          return {
            mode: "local",
            model: LOCAL_MODEL,
            source: config.embedding?.local?.source ?? "custom",
            asset: "failed",
            runtime: "unloaded",
            error: { code: "invalid_source", message: error.message },
          }
        }
      }
      return {
        mode: "local",
        model: LOCAL_MODEL,
        source,
        asset: loadState.asset,
        runtime: "loading",
        progress: loadState.progress,
      }
    }

    let source: LocalSource
    let remoteHost: string
    try {
      ;({ source, remoteHost } = resolveLocalSource(config))
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      return {
        mode: "local",
        model: LOCAL_MODEL,
        source: config.embedding?.local?.source ?? "custom",
        asset: "failed",
        runtime: "unloaded",
        error: { code: "invalid_source", message: error.message },
      }
    }

    if (loadState.error && loadState.source === source && loadState.remoteHost === remoteHost) {
      return {
        mode: "local",
        model: LOCAL_MODEL,
        source,
        asset: "failed",
        runtime: "unloaded",
        progress: loadState.progress,
        error: loadState.error,
      }
    }
    if (loadState.asset && loadState.source === source && loadState.remoteHost === remoteHost) {
      return {
        mode: "local",
        model: LOCAL_MODEL,
        source,
        asset: loadState.asset,
        runtime: "unloaded",
        progress: loadState.progress,
      }
    }

    try {
      const inspected = await inspectLocalAsset(source, remoteHost)
      loadState = { phase: "unloaded", source, remoteHost, asset: inspected.cached ? "cached" : "missing" }
      return {
        mode: "local",
        model: LOCAL_MODEL,
        source,
        asset: inspected.cached ? "cached" : "missing",
        runtime: "unloaded",
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      loadState = {
        phase: "unloaded",
        source,
        remoteHost,
        asset: "failed",
        error: { code: "load_failed", message: error.message },
      }
      return {
        mode: "local",
        model: LOCAL_MODEL,
        source,
        asset: "failed",
        runtime: "unloaded",
        error: loadState.error,
      }
    }
  }

  export async function warmup(): Promise<void> {
    try {
      await getLocalExtractor()
      log.info("local embedding model ready")
    } catch (err) {
      log.warn("local embedding model warmup failed", { error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  export async function dispose(): Promise<void> {
    loadGeneration++
    loadState = { phase: "unloaded" }
    await localRuntime.dispose()
  }

  export function setLocalRuntimeControlsForTest(controls?: Partial<LocalRuntimeControls>) {
    runtimeControls = { ...defaultRuntimeControls(), ...controls }
  }

  async function resolveModel() {
    const config = await Config.current()
    const ec = config.embedding

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

    try {
      const extractor = await getLocalExtractor()
      return { mode: "local" as const, extractor, modelID: LOCAL_MODEL, dimensions: LOCAL_DIMENSIONS }
    } catch (err) {
      throw new Error(
        `Embedding unavailable: no API key configured and local model failed to load. ` +
          `Configure embedding config or check network. ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
