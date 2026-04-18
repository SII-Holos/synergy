import { describe, expect, test } from "bun:test"
import { Category } from "../../src/cortex/category"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

describe("Category", () => {
  describe("getBuiltin", () => {
    test("returns all builtin categories", () => {
      const builtin = Category.getBuiltin()
      expect(builtin).toHaveProperty("visual-engineering")
      expect(builtin).toHaveProperty("ultrabrain")
      expect(builtin).toHaveProperty("artistry")
      expect(builtin).toHaveProperty("quick")
      expect(builtin).toHaveProperty("most-capable")
      expect(builtin).toHaveProperty("writing")
      expect(builtin).toHaveProperty("general")
    })

    test("builtin categories have template fields", () => {
      const builtin = Category.getBuiltin()
      for (const config of Object.values(builtin)) {
        expect(config.description).toBeDefined()
        expect(config.promptAppend).toBeDefined()
      }
    })

    test("builtin categories do not hardcode models", () => {
      const builtin = Category.getBuiltin()
      for (const config of Object.values(builtin)) {
        expect(config.model).toBeUndefined()
      }
    })
  })

  describe("resolve", () => {
    test("returns undefined for undefined name", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const result = await Category.resolve(undefined)
          expect(result).toBeUndefined()
        },
      })
    })

    test("returns undefined for 'none'", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const result = await Category.resolve("none")
          expect(result).toBeUndefined()
        },
      })
    })

    test("resolves builtin category from configured role models", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "fallback/default-model",
          creative_model: "creative/visual-model",
          thinking_model: "thinking/reasoner",
          mid_model: "mid/generalist",
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Config.state.reset()
          const result = await Category.resolve("visual-engineering")
          expect(result).toBeDefined()
          expect(result?.model).toBe("creative/visual-model")
        },
      })
    })

    test("returns undefined for unknown category", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const result = await Category.resolve("nonexistent")
          expect(result).toBeUndefined()
        },
      })
    })

    test("user config overrides builtin", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          creative_model: "creative/visual-model",
          category: {
            "visual-engineering": {
              model: "custom/model",
              temperature: 0.9,
            },
          },
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Config.state.reset()
          const result = await Category.resolve("visual-engineering")
          expect(result).toBeDefined()
          expect(result?.model).toBe("custom/model")
          expect(result?.temperature).toBe(0.9)
          expect(result?.description).toBe("Frontend, UI/UX, design, styling, animation")
        },
      })
    })

    test("user can define custom category", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "fallback/default-model",
          category: {
            custom: {
              model: "custom/custom-model",
              description: "Custom category",
              temperature: 0.5,
            },
          },
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Config.state.reset()
          const result = await Category.resolve("custom")
          expect(result).toBeDefined()
          expect(result?.model).toBe("custom/custom-model")
        },
      })
    })
  })

  describe("list", () => {
    test("returns all builtin categories", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const categories = await Category.list()
          expect(categories).toContain("visual-engineering")
          expect(categories).toContain("ultrabrain")
          expect(categories).toContain("artistry")
          expect(categories).toContain("quick")
          expect(categories).toContain("most-capable")
          expect(categories).toContain("writing")
          expect(categories).toContain("general")
        },
      })
    })

    test("includes user-defined categories", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "fallback/default-model",
          category: {
            custom: {
              model: "custom/model",
              description: "Custom",
            },
          },
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Config.state.reset()
          const categories = await Category.list()
          expect(categories).toContain("custom")
          expect(categories).toContain("visual-engineering")
        },
      })
    })

    test("deduplicates categories", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          creative_model: "creative/visual-model",
          category: {
            "visual-engineering": {
              model: "custom/model",
            },
          },
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const categories = await Category.list()
          const visualCount = categories.filter((c) => c === "visual-engineering").length
          expect(visualCount).toBe(1)
        },
      })
    })
  })

  describe("descriptions", () => {
    test("returns formatted descriptions", () => {
      const descriptions = Category.descriptions()
      expect(descriptions).toContain("visual-engineering")
      expect(descriptions).toContain("ultrabrain")
      expect(descriptions).toContain("most-capable")
      expect(descriptions).toContain("Frontend, UI/UX")
      expect(descriptions).toContain("Strict architecture")
    })

    test("uses markdown formatting", () => {
      const descriptions = Category.descriptions()
      expect(descriptions).toContain("`visual-engineering`")
      expect(descriptions).toContain("`ultrabrain`")
    })
  })
})
