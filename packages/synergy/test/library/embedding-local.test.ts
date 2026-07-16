import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Embedding } from "../../src/vector/embedding"

const originalConfigCurrent = Config.current

function localConfig(local?: { source?: "huggingface" | "hf-mirror" | "custom"; remoteHost?: string }) {
  return { embedding: local ? { local } : undefined } as Config.Info
}

function extractor() {
  return Object.assign(
    mock(async () => ({ data: new Float32Array([0.1, 0.2]) })),
    {
      dispose: mock(async () => {}),
    },
  )
}

beforeEach(async () => {
  await Embedding.dispose()
  ;(Config.current as typeof Config.current) = mock(async () => localConfig())
})

afterEach(async () => {
  Embedding.setLocalRuntimeControlsForTest()
  await Embedding.dispose()
  ;(Config.current as typeof Config.current) = originalConfigCurrent
})

describe("local embedding config", () => {
  test("keeps the zero-config default and accepts built-in download sources", () => {
    expect(Config.EmbeddingConfig.safeParse(undefined).success).toBe(true)
    expect(Config.EmbeddingConfig.safeParse({ local: { source: "huggingface" } }).success).toBe(true)
    expect(Config.EmbeddingConfig.safeParse({ local: { source: "hf-mirror" } }).success).toBe(true)
  })

  test("requires a dedicated origin for custom download sources", () => {
    expect(Config.EmbeddingConfig.safeParse({ local: { source: "custom" } }).success).toBe(false)
    expect(
      Config.EmbeddingConfig.safeParse({ local: { source: "custom", remoteHost: "https://models.example" } }).success,
    ).toBe(true)
  })

  test("rejects custom sources that are not public HTTPS origins", () => {
    for (const remoteHost of [
      "http://models.example",
      "https://127.0.0.1",
      "https://[fe90::1]",
      "https://models.example/path",
    ]) {
      expect(Config.EmbeddingConfig.safeParse({ local: { source: "custom", remoteHost } }).success).toBe(false)
    }
  })

  test("tolerates a retained custom origin after switching back to a built-in source", () => {
    expect(
      Config.EmbeddingConfig.safeParse({
        local: { source: "huggingface", remoteHost: "https://models.example" },
      }).success,
    ).toBe(true)
  })
})

describe("local embedding asset", () => {
  test("single-flights concurrent local initialization and reports aggregate progress", async () => {
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
          progress: 25,
          loaded: 20,
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

    const first = Embedding.warmup()
    const second = Embedding.warmup()
    await Bun.sleep(0)

    expect(pipeline).toHaveBeenCalledTimes(1)
    expect(await Embedding.status()).toMatchObject({
      mode: "local",
      asset: "downloading",
      runtime: "loading",
      progress: { loadedBytes: 20, totalBytes: 80, percent: 25 },
    })

    resolvePipeline?.(extractor())
    await Promise.all([first, second])

    expect(await Embedding.status()).toMatchObject({
      mode: "local",
      asset: "cached",
      runtime: "ready",
      progress: { loadedBytes: 80, totalBytes: 80, percent: 100 },
    })
  })

  test("falls back to the disk cache after a network load failure", async () => {
    const ready = extractor()
    const pipeline = mock(async (_task: string, _model: string, options: { local_files_only?: true }) => {
      if (!options.local_files_only) throw new Error("hub unavailable")
      return ready
    })
    Embedding.setLocalRuntimeControlsForTest({
      loadRuntime: async () => ({
        pipeline,
        isCached: mock(async () => true),
        configure() {},
      }),
    })

    await expect(Embedding.warmup()).resolves.toBeUndefined()

    expect(pipeline).toHaveBeenCalledTimes(2)
    expect(pipeline.mock.calls[1]?.[2]).toMatchObject({ local_files_only: true })
    expect(await Embedding.status()).toMatchObject({ asset: "cached", runtime: "ready" })
  })

  test("allows a failed explicit download to retry in the same process", async () => {
    const ready = extractor()
    const pipeline = mock(async () => {
      if (pipeline.mock.calls.length <= 2) throw new Error("hub unavailable")
      return ready
    })
    Embedding.setLocalRuntimeControlsForTest({
      loadRuntime: async () => ({
        pipeline,
        isCached: mock(async () => false),
        configure() {},
      }),
    })

    await expect(Embedding.warmup()).rejects.toThrow("hub unavailable")
    expect(await Embedding.status()).toMatchObject({
      mode: "local",
      asset: "failed",
      runtime: "unloaded",
      error: { message: "hub unavailable" },
    })

    await expect(Embedding.warmup()).resolves.toBeUndefined()
    expect(pipeline).toHaveBeenCalledTimes(3)
    expect(await Embedding.status()).toMatchObject({ asset: "cached", runtime: "ready" })
  })

  test("uses the configured mirror before checking cache or loading the pipeline", async () => {
    ;(Config.current as typeof Config.current) = mock(async () => localConfig({ source: "hf-mirror" }))
    const order: string[] = []
    let configuredHost = ""
    Embedding.setLocalRuntimeControlsForTest({
      loadRuntime: async () => ({
        configure(input) {
          configuredHost = input.remoteHost
          order.push("configure")
        },
        isCached: mock(async () => {
          order.push("cache")
          return true
        }),
        pipeline: mock(async () => {
          order.push("pipeline")
          return extractor()
        }),
      }),
    })

    await Embedding.warmup()

    expect(configuredHost).toBe("https://hf-mirror.com/")
    expect(order).toEqual(["configure", "cache", "pipeline"])
    expect(await Embedding.status()).toMatchObject({ source: "hf-mirror", asset: "cached", runtime: "ready" })
  })

  test("rejects unsafe custom mirror origins before loading runtime assets", async () => {
    ;(Config.current as typeof Config.current) = mock(async () =>
      localConfig({ source: "custom", remoteHost: "http://127.0.0.1:8080" }),
    )
    const loadRuntime = mock(async () => {
      throw new Error("must not load")
    })
    Embedding.setLocalRuntimeControlsForTest({ loadRuntime })

    await expect(Embedding.warmup()).rejects.toThrow("public HTTPS origin")
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  test("reports remote mode without inspecting or loading local assets", async () => {
    ;(Config.current as typeof Config.current) = mock(async () => ({
      embedding: { apiKey: "secret", baseURL: "https://embedding.example/v1", model: "embed-model" },
    }))
    const loadRuntime = mock(async () => {
      throw new Error("must not load")
    })
    Embedding.setLocalRuntimeControlsForTest({ loadRuntime })

    expect(await Embedding.status()).toEqual({
      mode: "remote",
      model: "embed-model",
      baseURL: "https://embedding.example/v1",
    })
    expect(loadRuntime).not.toHaveBeenCalled()
  })
})
