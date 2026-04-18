import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { Embedding } from "../../src/engram/embedding"
import { Log } from "../../src/util/log"

Log.init({ print: false })

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
