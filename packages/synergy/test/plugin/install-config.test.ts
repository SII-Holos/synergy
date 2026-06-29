import { describe, expect, test } from "bun:test"
import { nextConfiguredPluginSpecsForInstall } from "../../src/plugin/install"

describe("nextConfiguredPluginSpecsForInstall", () => {
  test("replaces older specs that resolve to the same plugin id", async () => {
    const result = await nextConfiguredPluginSpecsForInstall(
      [
        "github:EricSanchezok/synergy-frontend-kit",
        "file:///Users/eric/.synergy/cache/plugin-market/artifacts/synergy-meme-plugin/0.3.2/synergy-meme-plugin-0.3.2.synergy-plugin.tgz",
      ],
      {
        spec: "file:///Users/eric/.synergy/cache/plugin-market/artifacts/synergy-frontend-kit/0.2.1/synergy-frontend-kit-0.2.1.synergy-plugin.tgz",
        pluginId: "synergy-frontend-kit",
        resolvePluginId: async (spec) =>
          spec === "github:EricSanchezok/synergy-frontend-kit" ? "synergy-frontend-kit" : null,
      },
    )

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
    const result = await nextConfiguredPluginSpecsForInstall(["github:EricSanchezok/synergy-frontend-kit", target], {
      spec: target,
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
})
