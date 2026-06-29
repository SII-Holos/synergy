import { describe, expect, test } from "bun:test"
import { canonicalizePluginSpecs } from "../../src/plugin/installation-transaction"

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
