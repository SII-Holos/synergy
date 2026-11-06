import { describe, expect, test } from "bun:test"
import { loadRegistryResource } from "../../../src/plugin/marketplace/registry-resource"

describe("plugin marketplace registry resources", () => {
  test("returns loaded data without an unavailable state", async () => {
    const result = await loadRegistryResource(async () => ["plugin"], [])
    expect(result).toEqual({ data: ["plugin"], unavailable: false })
  })

  test("converts request failures into a non-throwing unavailable state", async () => {
    const result = await loadRegistryResource(async () => {
      throw new Error("Official plugin registry temporarily unavailable")
    }, [])
    expect(result).toEqual({ data: [], unavailable: true })
  })

  test("treats an expected missing plugin as an available empty result", async () => {
    const result = await loadRegistryResource(
      async () => {
        throw new Error("Registry plugin not found: missing")
      },
      [],
      { isMissing: (error) => error instanceof Error && error.message === "Registry plugin not found: missing" },
    )
    expect(result).toEqual({ data: [], unavailable: false })
  })
})
