import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "../../src/config/config"
import { Embedding } from "../../src/vector/embedding"
import { LibraryRoute } from "../../src/server/library"

const originalConfigCurrent = Config.current

function app() {
  return new Hono().route("/library", LibraryRoute)
}

function extractor() {
  return mock(async () => ({ data: new Float32Array([0.1, 0.2]) }))
}

beforeEach(() => {
  Embedding.dispose()
  ;(Config.current as typeof Config.current) = mock(async () => ({}))
})

afterEach(() => {
  Embedding.setLocalRuntimeControlsForTest()
  Embedding.dispose()
  ;(Config.current as typeof Config.current) = originalConfigCurrent
})

describe("Library embedding API", () => {
  test("reports local asset status without loading the model", async () => {
    const pipeline = mock(async () => extractor())
    Embedding.setLocalRuntimeControlsForTest({
      loadRuntime: async () => ({
        pipeline,
        isCached: mock(async () => false),
        configure() {},
      }),
    })

    const response = await app().request("/library/embedding/status")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      mode: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      source: "huggingface",
      asset: "missing",
      runtime: "unloaded",
    })
    expect(pipeline).not.toHaveBeenCalled()
  })

  test("starts a local download without waiting and reuses the active load", async () => {
    let resolvePipeline: ((value: ReturnType<typeof extractor>) => void) | undefined
    const pipeline = mock(
      async (
        _task: string,
        _model: string,
        options: {
          dtype: "q8"
          progress_callback: (info: { status?: string; progress?: number; loaded?: number; total?: number }) => void
        },
      ) => {
        options.progress_callback?.({
          status: "progress_total",
          progress: 40,
          loaded: 32,
          total: 80,
        })
        return await new Promise<ReturnType<typeof extractor>>((resolve) => {
          resolvePipeline = resolve
        })
      },
    )
    Embedding.setLocalRuntimeControlsForTest({
      loadRuntime: async () => ({
        pipeline,
        isCached: mock(async () => false),
        configure() {},
      }),
    })

    const first = await app().request("/library/embedding/download", { method: "POST" })
    const second = await app().request("/library/embedding/download", { method: "POST" })

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(await second.json()).toMatchObject({
      mode: "local",
      asset: "downloading",
      runtime: "loading",
      progress: { loadedBytes: 32, totalBytes: 80, percent: 40 },
    })
    expect(pipeline).toHaveBeenCalledTimes(1)

    resolvePipeline?.(extractor())
    await Embedding.warmup()
  })

  test("rejects local downloads when a remote embedding service is configured", async () => {
    ;(Config.current as typeof Config.current) = mock(async () => ({
      embedding: { apiKey: "secret", baseURL: "https://embedding.example/v1", model: "embed-model" },
    }))
    const loadRuntime = mock(async () => {
      throw new Error("must not load")
    })
    Embedding.setLocalRuntimeControlsForTest({ loadRuntime })

    const response = await app().request("/library/embedding/download", { method: "POST" })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      code: "EMBEDDING_REMOTE_CONFIGURED",
      message: "Local embedding download is unavailable while a remote embedding service is configured",
    })
    expect(loadRuntime).not.toHaveBeenCalled()
  })
})
