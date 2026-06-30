import { describe, expect, test } from "bun:test"
import { canonicalizePluginSpecs } from "../../src/plugin/installation-transaction"
import { satisfiesSynergyEngine } from "../../src/plugin/install"

describe("canonicalizePluginSpecs", () => {
  test("replaces older specs that resolve to the same plugin id", async () => {
    const result = await canonicalizePluginSpecs({
      specs: [
        "github:EricSanchezok/synergy-frontend-kit",
        "file:///Users/eric/.synergy/cache/plugin-market/artifacts/synergy-meme-plugin/0.3.2/synergy-meme-plugin-0.3.2.synergy-plugin.tgz",
      ],
      targetSpec:
        "file:///Users/eric/.synergy/cache/plugin-market/artifacts/synergy-frontend-kit/0.2.1/synergy-frontend-kit-0.2.1.synergy-plugin.tgz",
      pluginId: "synergy-frontend-kit",
      resolvePluginId: async (spec) =>
        spec === "github:EricSanchezok/synergy-frontend-kit" ? "synergy-frontend-kit" : null,
    })

    expect(result).toEqual({
      plugins: [
        "file:///Users/eric/.synergy/cache/plugin-market/artifacts/synergy-meme-plugin/0.3.2/synergy-meme-plugin-0.3.2.synergy-plugin.tgz",
        "file:///Users/eric/.synergy/cache/plugin-market/artifacts/synergy-frontend-kit/0.2.1/synergy-frontend-kit-0.2.1.synergy-plugin.tgz",
      ],
      removed: ["github:EricSanchezok/synergy-frontend-kit"],
      changed: true,
    })
  })

  test("keeps an existing target spec and removes duplicate older specs", async () => {
    const target =
      "file:///Users/eric/.synergy/cache/plugin-market/artifacts/synergy-frontend-kit/0.2.1/synergy-frontend-kit-0.2.1.synergy-plugin.tgz"
    const result = await canonicalizePluginSpecs({
      specs: ["github:EricSanchezok/synergy-frontend-kit", target],
      targetSpec: target,
      pluginId: "synergy-frontend-kit",
      resolvePluginId: async (spec) =>
        spec === "github:EricSanchezok/synergy-frontend-kit" ? "synergy-frontend-kit" : null,
    })

    expect(result).toEqual({
      plugins: [target],
      removed: ["github:EricSanchezok/synergy-frontend-kit"],
      changed: true,
    })
  })

  test("keeps the lockfile spec when duplicate specs disagree", async () => {
    const oldSpec = "file:///tmp/plugin-1.0.0.synergy-plugin.tgz"
    const newSpec = "file:///tmp/plugin-1.1.0.synergy-plugin.tgz"
    const result = await canonicalizePluginSpecs({
      specs: [oldSpec, newSpec],
      pluginId: "demo-plugin",
      targetSpec: newSpec,
      lockSpec: oldSpec,
      resolvePluginId: async () => "demo-plugin",
    })

    expect(result.plugins).toEqual([oldSpec])
    expect(result.removed).toEqual([newSpec])
    expect(result.changed).toBe(true)
  })
})

describe("satisfiesSynergyEngine", () => {
  test("accepts current versions that satisfy engines.synergy", () => {
    expect(satisfiesSynergyEngine("1.2.3", ">=1.2.0")).toBe(true)
    expect(satisfiesSynergyEngine("1.2.3", "1.2.3")).toBe(true)
    expect(satisfiesSynergyEngine("1.2.3", ">=1.0.0 <2.0.0")).toBe(true)
  })

  test("rejects current versions that do not satisfy engines.synergy", () => {
    expect(satisfiesSynergyEngine("1.2.3", ">=1.3.0")).toBe(false)
    expect(satisfiesSynergyEngine("1.2.3", "1.2.4")).toBe(false)
    expect(satisfiesSynergyEngine("1.2.3", ">=2.0.0 <3.0.0")).toBe(false)
  })

  test("rejects unsupported engines.synergy ranges", () => {
    expect(satisfiesSynergyEngine("1.2.3", "^1.2.0")).toBe(false)
  })
})
