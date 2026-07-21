import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { Embedding, LocalEmbeddingRuntime, type LocalExtractor } from "../../src/vector/embedding"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function createExtractor(): LocalExtractor {
  return Object.assign(async () => ({ data: new Float32Array([1]) }), {
    dispose: mock(async () => {}),
  })
}

describe("Embedding", () => {
  describe("Info schema", () => {
    test("validates correct shape", () => {
      const result = Embedding.Info.safeParse({
        id: "test-id",
        vector: [0.1, 0.2, 0.3],
        model: "test-model",
      })
      expect(result.success).toBe(true)
    })

    test("rejects missing id", () => {
      const result = Embedding.Info.safeParse({
        vector: [0.1, 0.2, 0.3],
        model: "test-model",
      })
      expect(result.success).toBe(false)
    })

    test("rejects missing vector", () => {
      const result = Embedding.Info.safeParse({
        id: "test-id",
        model: "test-model",
      })
      expect(result.success).toBe(false)
    })

    test("rejects missing model", () => {
      const result = Embedding.Info.safeParse({
        id: "test-id",
        vector: [0.1, 0.2, 0.3],
      })
      expect(result.success).toBe(false)
    })

    test("rejects non-array vector", () => {
      const result = Embedding.Info.safeParse({
        id: "test-id",
        vector: "not-an-array",
        model: "test-model",
      })
      expect(result.success).toBe(false)
    })

    test("accepts empty vector array", () => {
      const result = Embedding.Info.safeParse({
        id: "test-id",
        vector: [],
        model: "test-model",
      })
      expect(result.success).toBe(true)
    })

    test("rejects non-number vector elements", () => {
      const result = Embedding.Info.safeParse({
        id: "test-id",
        vector: ["a", "b"],
        model: "test-model",
      })
      expect(result.success).toBe(false)
    })

    test("has the correct type inference", () => {
      const parsed = Embedding.Info.parse({
        id: "test-id",
        vector: [0.1, 0.2],
        model: "test-model",
      })
      expect(parsed.id).toBe("test-id")
      expect(parsed.vector).toEqual([0.1, 0.2])
      expect(parsed.model).toBe("test-model")
    })
  })

  describe("LocalEmbeddingRuntime", () => {
    test("shares one in-flight pipeline load", async () => {
      let loads = 0
      const extractor = createExtractor()
      const runtime = new LocalEmbeddingRuntime(async () => {
        loads++
        await Bun.sleep(5)
        return extractor
      })

      const [first, second] = await Promise.all([runtime.get(), runtime.get()])

      expect(loads).toBe(1)
      expect(first).toBe(extractor)
      expect(second).toBe(extractor)
    })

    test("dispose releases the loaded pipeline exactly once", async () => {
      const extractor = createExtractor()
      const runtime = new LocalEmbeddingRuntime(async () => extractor)
      await runtime.get()

      await runtime.dispose()
      await runtime.dispose()

      expect(extractor.dispose).toHaveBeenCalledTimes(1)
    })

    test("dispose releases a pipeline that finishes loading concurrently", async () => {
      const deferred = Promise.withResolvers<LocalExtractor>()
      const extractor = createExtractor()
      const runtime = new LocalEmbeddingRuntime(() => deferred.promise)
      const loading = runtime.get()
      const disposing = runtime.dispose()

      deferred.resolve(extractor)

      await expect(loading).rejects.toThrow("disposed during load")
      await disposing
      expect(extractor.dispose).toHaveBeenCalledTimes(1)
    })
  })

  describe("generateBatch", () => {
    test("returns empty array for empty input", async () => {
      const result = await Embedding.generateBatch([])
      expect(result).toEqual([])
    })
  })

  describe("generate", () => {
    test("throws when embedding cannot be generated without proper config", async () => {
      await expect(Embedding.generate({ id: "test", text: "hello" })).rejects.toThrow()
    })
  })
})
