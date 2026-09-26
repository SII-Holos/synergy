import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { Embedding, LocalEmbeddingRuntime, type LocalExtractor } from "../src/vector/embedding"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

beforeEach(() =>
  runtime.run(async () => {
    await Embedding.resetForTest()
  }),
)

afterEach(() =>
  runtime.run(async () => {
    await Embedding.resetForTest()
  }),
)

function createExtractor(): LocalExtractor {
  return Object.assign(async () => ({ data: new Float32Array([1]) }), {
    dispose: mock(async () => {}),
  })
}

describe("Embedding", () => {
  describe("Info schema", () => {
    test("validates correct shape", () =>
      runtime.run(() => {
        const result = Embedding.Info.safeParse({
          id: "test-id",
          vector: [0.1, 0.2, 0.3],
          model: "test-model",
        })
        expect(result.success).toBe(true)
      }))

    test("rejects missing id", () =>
      runtime.run(() => {
        const result = Embedding.Info.safeParse({
          vector: [0.1, 0.2, 0.3],
          model: "test-model",
        })
        expect(result.success).toBe(false)
      }))

    test("rejects missing vector", () =>
      runtime.run(() => {
        const result = Embedding.Info.safeParse({
          id: "test-id",
          model: "test-model",
        })
        expect(result.success).toBe(false)
      }))

    test("rejects missing model", () =>
      runtime.run(() => {
        const result = Embedding.Info.safeParse({
          id: "test-id",
          vector: [0.1, 0.2, 0.3],
        })
        expect(result.success).toBe(false)
      }))

    test("rejects non-array vector", () =>
      runtime.run(() => {
        const result = Embedding.Info.safeParse({
          id: "test-id",
          vector: "not-an-array",
          model: "test-model",
        })
        expect(result.success).toBe(false)
      }))

    test("accepts empty vector array", () =>
      runtime.run(() => {
        const result = Embedding.Info.safeParse({
          id: "test-id",
          vector: [],
          model: "test-model",
        })
        expect(result.success).toBe(true)
      }))

    test("rejects non-number vector elements", () =>
      runtime.run(() => {
        const result = Embedding.Info.safeParse({
          id: "test-id",
          vector: ["a", "b"],
          model: "test-model",
        })
        expect(result.success).toBe(false)
      }))

    test("has the correct type inference", () =>
      runtime.run(() => {
        const parsed = Embedding.Info.parse({
          id: "test-id",
          vector: [0.1, 0.2],
          model: "test-model",
        })
        expect(parsed.id).toBe("test-id")
        expect(parsed.vector).toEqual([0.1, 0.2])
        expect(parsed.model).toBe("test-model")
      }))
  })

  describe("LocalEmbeddingRuntime", () => {
    test("shares one in-flight pipeline load", () =>
      runtime.run(async () => {
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
      }))

    test("dispose releases the loaded pipeline exactly once", () =>
      runtime.run(async () => {
        const extractor = createExtractor()
        const runtime = new LocalEmbeddingRuntime(async () => extractor)
        await runtime.get()

        await runtime.dispose()
        await runtime.dispose()

        expect(extractor.dispose).toHaveBeenCalledTimes(1)
      }))

    test("dispose releases a pipeline that finishes loading concurrently", () =>
      runtime.run(async () => {
        const deferred = Promise.withResolvers<LocalExtractor>()
        const extractor = createExtractor()
        const runtime = new LocalEmbeddingRuntime(() => deferred.promise)
        const loading = runtime.get()
        const disposing = runtime.dispose()

        deferred.resolve(extractor)

        await expect(loading).rejects.toThrow("disposed during load")
        await disposing
        expect(extractor.dispose).toHaveBeenCalledTimes(1)
      }))
  })

  describe("generateBatch", () => {
    test("returns empty array for empty input", () =>
      runtime.run(async () => {
        const result = await Embedding.generateBatch([])
        expect(result).toEqual([])
      }))
  })

  describe("generate", () => {
    test("throws when embedding cannot be generated without proper config", () =>
      runtime.run(async () => {
        await expect(Embedding.generate({ id: "test", text: "hello" })).rejects.toThrow()
      }))
  })
})

afterRuntimeTests(() => runtime.close())
