import { describe, expect, test } from "bun:test"
import { resolveDefinitionLoaderPath } from "../src/lib/definition"

describe("plugin definition loader", () => {
  test("prefers the compiled packaged loader", () => {
    const loader = resolveDefinitionLoaderPath(import.meta.url, (candidate) => candidate.endsWith(".js"))
    expect(loader.endsWith("definition-loader-child.js")).toBe(true)
  })

  test("falls back to the source loader during monorepo development", () => {
    const loader = resolveDefinitionLoaderPath(import.meta.url, () => false)
    expect(loader.endsWith("definition-loader-child.ts")).toBe(true)
  })
})
